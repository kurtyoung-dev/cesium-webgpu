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
// The tracked catalog is expected to be current. These tests prove both the
// green exact-match path and fail-closed drift/structure paths.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BEGIN_MARKER,
  END_MARKER,
  archivePlanAnchor,
  archivePlanRows,
  catalogCheckExitCode,
  classify,
  collectCensus,
  describeDrift,
  describeDriftDetailed,
  inboundRefSources,
  inboundRefs,
  isReferenceSourcePath,
  isUnderArchiveDirectory,
  listTrackedPaths,
  listToolingFiles,
  parseCandidateIndexEntries,
  parseLastTouchHistory,
  parseTrackedPathList,
  readTrackedFiles,
  renderCensus,
  resolveReferenceToken,
  runtimeCandidateBindingReasons,
  splitCatalog,
  withFrozenCandidateIndex,
  writeCatalogIfUnchanged,
} from "./generate-tooling-catalog.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CATALOG = path.join(ROOT, "migration_doc", "TOOLING_CATALOG.md");
const LAUNCHER_REL = "Tools/generate-tooling-catalog-launcher.cjs";
const SCRIPT = path.join(ROOT, ...LAUNCHER_REL.split("/"));
const GENERATOR = path.join(ROOT, "Tools", "generate-tooling-catalog.mjs");

function listToolingFilesFromCandidateGit(root = ROOT) {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--", "Tools", "scripts"],
    {
      cwd: root,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    result.stderr || result.error?.message || "git ls-files failed",
  );
  return result.stdout
    .split("\0")
    .filter((rel) => rel.endsWith(".mjs"))
    .sort();
}

function assertToolingCensusAgreement(files, independentlyDerivedFiles) {
  assert.equal(
    files.length,
    independentlyDerivedFiles.length,
    "the generator and independent candidate-index census counts disagree",
  );
}

function readFrozenToolingCensus(root, fixturePath) {
  return withFrozenCandidateIndex((subject) => {
    const files = listToolingFiles();
    const independentlyDerivedFiles = listToolingFilesFromCandidateGit(
      subject.root,
    );
    assertToolingCensusAgreement(files, independentlyDerivedFiles);
    return {
      fixtureTracked: new Set(
        listTrackedPaths(["Tools", "scripts"], subject.root),
      ).has(fixturePath),
      generatorCount: files.length,
      independentCount: independentlyDerivedFiles.length,
    };
  }, root);
}

function createCandidateSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "catalog-index-mutant-"));
  const gitDir = path.join(root, "git");
  const sourceSnapshot = spawnSync("git", ["ls-files", "--stage", "-z"], {
    cwd: ROOT,
    env: process.env,
  });
  assert.equal(
    sourceSnapshot.status,
    0,
    sourceSnapshot.stderr?.toString("utf8"),
  );
  const sourceHead = spawnSync(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: ROOT, env: process.env, encoding: "utf8" },
  );
  assert.equal(sourceHead.status, 0, sourceHead.stderr);
  const sourceObjectPath = spawnSync(
    "git",
    ["rev-parse", "--git-path", "objects"],
    { cwd: ROOT, env: process.env, encoding: "utf8" },
  );
  assert.equal(sourceObjectPath.status, 0, sourceObjectPath.stderr);
  const parentObjects = path.resolve(ROOT, sourceObjectPath.stdout.trim());
  const alternates = [
    parentObjects,
    ...(process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? "")
      .split(path.delimiter)
      .filter(Boolean),
  ].join(path.delimiter);
  const initEnv = { ...process.env };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
  ]) {
    delete initEnv[name];
  }
  const init = spawnSync("git", ["init", "--bare", gitDir], {
    cwd: ROOT,
    env: initEnv,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  const objects = path.join(gitDir, "objects");
  const index = path.join(gitDir, "index");
  const env = {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
    GIT_WORK_TREE: ROOT,
  };
  delete env.GIT_INDEX_FILE;
  delete env.GIT_NO_REPLACE_OBJECTS;
  delete env.GIT_REPLACE_REF_BASE;
  delete env.GIT_SHALLOW_FILE;
  const updateRef = spawnSync(
    "git",
    ["update-ref", "refs/heads/catalog-candidate", sourceHead.stdout.trim()],
    { cwd: ROOT, env, encoding: "utf8" },
  );
  assert.equal(updateRef.status, 0, updateRef.stderr);
  const symbolicHead = spawnSync(
    "git",
    ["symbolic-ref", "HEAD", "refs/heads/catalog-candidate"],
    { cwd: ROOT, env, encoding: "utf8" },
  );
  assert.equal(symbolicHead.status, 0, symbolicHead.stderr);
  const materialize = spawnSync("git", ["update-index", "-z", "--index-info"], {
    cwd: ROOT,
    env,
    input: sourceSnapshot.stdout,
  });
  assert.equal(materialize.status, 0, materialize.stderr?.toString("utf8"));
  return { env, gitDir, index, objects, root };
}

function writeCandidateBlob(sandbox, source) {
  const hash = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: ROOT,
    env: sandbox.env,
    input: source,
    encoding: "utf8",
  });
  assert.equal(hash.status, 0, hash.stderr);
  return hash.stdout.trim();
}

function candidatePathOid(sandbox, pathname) {
  const listed = spawnSync("git", ["ls-files", "--stage", "--", pathname], {
    cwd: ROOT,
    env: sandbox.env,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  const match = /^100644 ([0-9a-f]{40,64}) 0\t/u.exec(listed.stdout);
  assert.ok(match, `candidate path is unavailable: ${pathname}`);
  return match[1];
}

function readCandidateObject(sandbox, oid) {
  const read = spawnSync("git", ["cat-file", "blob", oid], {
    cwd: ROOT,
    env: { ...sandbox.env, GIT_NO_REPLACE_OBJECTS: "1" },
    encoding: "utf8",
  });
  assert.equal(read.status, 0, read.stderr);
  return read.stdout;
}

function updateCandidatePath(sandbox, pathname, source) {
  const oid = writeCandidateBlob(sandbox, source);
  const update = spawnSync(
    "git",
    ["update-index", "--cacheinfo", `100644,${oid},${pathname}`],
    { cwd: ROOT, env: sandbox.env, encoding: "utf8" },
  );
  assert.equal(update.status, 0, update.stderr);
  return oid;
}

function installReplacement(sandbox, originalOid, replacementOid) {
  const update = spawnSync(
    "git",
    ["update-ref", `refs/replace/${originalOid}`, replacementOid],
    { cwd: ROOT, env: sandbox.env, encoding: "utf8" },
  );
  assert.equal(update.status, 0, update.stderr);
}

function runCandidate(sandbox, args = ["--check"], extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...sandbox.env, ...extraEnv },
    encoding: "utf8",
  });
}

/**
 * Assert a `--check` result reports the census as current.
 *
 * Many tests below spawn this as a POSITIVE CONTROL after proving an
 * unrelated mutation is rejected, so a harness that rejected everything
 * regardless of input would not pass vacuously. When it fails, the almost
 * always cause is that the TRACKED migration_doc/TOOLING_CATALOG.md itself
 * has drifted from the tree — a precondition this test does not control and
 * is not exercising — not a defect in whatever the surrounding test is
 * actually about. The prefix below says so up front so a drifted-catalog
 * failure is never mistaken for one of those defects; the check itself
 * (status 0 and the exact "census is current" text) is unchanged.
 *
 * @param {{status: number|null, stdout: string, stderr: string}} result Spawned `--check` result.
 * @param {string} [context] Extra context to lead the failure message with.
 */
function assertCensusCurrent(result, context = "") {
  const prefix = context === "" ? "" : `${context}: `;
  assert.equal(
    result.status,
    0,
    `${prefix}census-currency precondition failed — if this is a DRIFTED ` +
      `report, migration_doc/TOOLING_CATALOG.md itself is stale relative to ` +
      `the tree and needs regenerating (\`node ${LAUNCHER_REL}\`, then ` +
      `commit), independently of what this test exercises:\n${result.stderr}`,
  );
  assert.match(result.stdout, /census is current/u);
}

function updateCandidateEntry(sandbox, pathname, mode, oid) {
  const update = spawnSync(
    "git",
    [
      "update-index",
      "--info-only",
      "--add",
      "--cacheinfo",
      `${mode},${oid},${pathname}`,
    ],
    { cwd: ROOT, env: sandbox.env, encoding: "utf8" },
  );
  assert.equal(update.status, 0, update.stderr);
}

function updateCandidateEntryRaw(sandbox, pathname, mode, oid) {
  const original = readFileSync(sandbox.index);
  assert.equal(original.subarray(0, 4).toString("ascii"), "DIRC");
  assert.equal(original.readUInt32BE(4), 2, "raw fixture requires index v2");
  const count = original.readUInt32BE(8);
  const entries = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const start = offset;
    const flags = original.readUInt16BE(start + 60);
    const headerLength = (flags & 0x4000) === 0 ? 62 : 64;
    const nul = original.indexOf(0, start + headerLength);
    assert.notEqual(nul, -1, "candidate index entry lacks a path terminator");
    const length = nul + 1 - start;
    offset = start + length + ((8 - (length % 8)) % 8);
    entries.push({
      bytes: original.subarray(start, offset),
      name: original.subarray(start + headerLength, nul),
    });
  }

  const name = Buffer.from(pathname, "utf8");
  const fixed = Buffer.alloc(62);
  fixed.writeUInt32BE(Number.parseInt(mode, 8), 24);
  Buffer.from(oid, "hex").copy(fixed, 40);
  fixed.writeUInt16BE(Math.min(name.length, 0x0fff), 60);
  const unpaddedLength = fixed.length + name.length + 1;
  const raw = Buffer.alloc(unpaddedLength + ((8 - (unpaddedLength % 8)) % 8));
  fixed.copy(raw);
  name.copy(raw, fixed.length);
  entries.push({ bytes: raw, name });
  entries.sort((a, b) => Buffer.compare(a.name, b.name));

  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries.map((entry) => entry.bytes)]);
  const checksum = createHash("sha1").update(body).digest();
  writeFileSync(sandbox.index, Buffer.concat([body, checksum]));
}

function createRuntimeWorktree(
  sandbox,
  generatorSource,
  parserSource = readCandidateObject(
    sandbox,
    candidatePathOid(sandbox, "Tools/lib/purpose-header.mjs"),
  ),
  launcherSource = readFileSync(SCRIPT),
) {
  const worktree = path.join(sandbox.root, "runtime-worktree");
  const launcherPath = path.join(worktree, ...LAUNCHER_REL.split("/"));
  const generatorPath = path.join(
    worktree,
    "Tools",
    "generate-tooling-catalog.mjs",
  );
  const parserPath = path.join(worktree, "Tools", "lib", "purpose-header.mjs");
  mkdirSync(path.dirname(launcherPath), { recursive: true });
  mkdirSync(path.dirname(generatorPath), { recursive: true });
  mkdirSync(path.dirname(parserPath), { recursive: true });
  writeFileSync(launcherPath, launcherSource);
  writeFileSync(generatorPath, generatorSource);
  writeFileSync(parserPath, parserSource);
  return {
    env: { ...sandbox.env, GIT_WORK_TREE: worktree },
    generatorPath,
    launcherPath,
    parserPath,
    worktree,
  };
}

function runRuntimeWorktree(runtime, args = ["--check"], extraEnv = {}) {
  return spawnSync(process.execPath, [runtime.launcherPath, ...args], {
    cwd: runtime.worktree,
    env: { ...runtime.env, ...extraEnv },
    encoding: "utf8",
  });
}

function runDirectRuntimeGenerator(runtime, args = ["--check"], extraEnv = {}) {
  return spawnSync(process.execPath, [runtime.generatorPath, ...args], {
    cwd: runtime.worktree,
    env: {
      ...runtime.env,
      TOOLING_CATALOG_TRUSTED_LAUNCHER: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function withCandidateProcessEnvironment(sandbox, callback) {
  const names = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
  ];
  const prior = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) {
      if (sandbox.env[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = sandbox.env[name];
      }
    }
    return callback();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function installGitHistoryAbaShim(sandbox, head, variant = "shallow") {
  const locator = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [process.platform === "win32" ? "git.exe" : "git"],
    { encoding: "utf8" },
  );
  assert.equal(locator.status, 0, locator.stderr);
  const realGit = locator.stdout.split(/\r?\n/u).find(Boolean);
  assert.ok(realGit, "cannot resolve the real Git executable");

  const shimRoot = path.join(sandbox.root, "native-git-shim");
  const outputRoot = path.join(shimRoot, "out");
  const executable = path.join(
    outputRoot,
    process.platform === "win32" ? "git.exe" : "git",
  );
  const attackLog = path.join(shimRoot, `attack-${variant}.log`);
  const targetPath =
    variant === "graft"
      ? path.join(sandbox.gitDir, "info", "grafts")
      : path.join(sandbox.gitDir, "shallow");
  if (!existsSync(executable)) {
    mkdirSync(outputRoot, { recursive: true });
    copyFileSync(process.execPath, executable);
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }
    const preload = path.join(shimRoot, "git-history-aba.cjs");
    writeFileSync(
      preload,
      `const fs = require("node:fs");\n` +
        `const path = require("node:path");\n` +
        `const { spawnSync } = require("node:child_process");\n` +
        `if (path.resolve(process.execPath) === path.resolve(process.env.CATALOG_GIT_SHIM_EXECUTABLE)) {\n` +
        `  const args = process.argv.slice(1); args[0] = path.basename(args[0]);\n` +
        `  const attack = args[0] === "log";\n` +
        `  const target = process.env.CATALOG_ABA_TARGET;\n` +
        `  if (attack) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, process.env.CATALOG_ABA_HEAD + "\\n"); fs.appendFileSync(process.env.CATALOG_ABA_LOG, "log\\n"); }\n` +
        `  let status = 2;\n` +
        `  try { const result = spawnSync(process.env.CATALOG_REAL_GIT, args, { env: process.env, stdio: "inherit" }); status = Number.isInteger(result.status) ? result.status : 2; } finally { if (attack) fs.rmSync(target, { force: true }); }\n` +
        `  process.exit(status);\n` +
        `}\n`,
    );
  }
  const preload = path.join(shimRoot, "git-history-aba.cjs");
  return {
    attackLog,
    env: {
      ...sandbox.env,
      CATALOG_ABA_HEAD: head,
      CATALOG_ABA_LOG: attackLog,
      CATALOG_ABA_TARGET: targetPath,
      CATALOG_GIT_SHIM_EXECUTABLE: executable,
      CATALOG_REAL_GIT: realGit,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`]
        .filter(Boolean)
        .join(" "),
      PATH: `${outputRoot}${path.delimiter}${process.env.PATH}`,
    },
    targetPath,
  };
}

function candidateIndexMutant(pathname, mutate) {
  const sandbox = createCandidateSandbox();
  try {
    const current = readTrackedFiles([pathname]).get(pathname);
    assert.equal(typeof current, "string");
    const mutated = mutate(current);
    assert.notEqual(mutated, current, "candidate mutant did not change bytes");
    updateCandidatePath(sandbox, pathname, mutated);
    return runCandidate(sandbox);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({ signal, status, stderr, stdout });
    });
  });
}

async function waitForPrivateSnapshot(snapshotParent) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const frozen = readdirSync(snapshotParent).some((name) =>
      existsSync(path.join(snapshotParent, name, "index")),
    );
    if (frozen) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("child did not materialize its private index");
}

/** The census is expensive (a git pass + ~1000 file reads); build it once. */
let censusCache = null;
const census = () => (censusCache ??= collectCensus());

// ---------------------------------------------------------------------------
// A. Scope and classification
// ---------------------------------------------------------------------------

test("A1: the census covers the whole tooling library", () => {
  const files = listToolingFiles();
  const independentlyDerivedFiles = listToolingFilesFromCandidateGit();
  assertToolingCensusAgreement(files, independentlyDerivedFiles);
  // Both derivations ultimately depend on Git. This coarse floor catches an
  // empty or severely partial result even if both Git calls agree.
  assert.ok(
    files.length >= 1000,
    "the .mjs census collapsed below its established four-digit scale",
  );
  assert.ok(files.every((f) => f.endsWith(".mjs")));
  assert.ok(files.includes("Tools/generate-tooling-catalog.mjs"));
  assert.equal(
    files.includes(LAUNCHER_REL),
    false,
    "the CommonJS launcher must stay outside the .mjs census",
  );
  assert.ok(files.some((f) => f.startsWith("scripts/")));
  assert.deepEqual(files, [...files].sort(), "the file list is not sorted");
  const tracked = new Set(listTrackedPaths(["Tools", "scripts"]));
  assert.ok(files.every((file) => tracked.has(file)));
  assert.ok(tracked.has(LAUNCHER_REL), "the launcher is not candidate-tracked");
});

test("A1: the derived count follows staged candidate-index changes", (t) => {
  assert.throws(
    () => assertToolingCensusAgreement(["Tools/example.mjs"], []),
    /independent candidate-index census counts disagree/u,
  );

  const sandbox = createCandidateSandbox();
  const fixturePath = "Tools/tooling-catalog-count-fixture.mjs";
  try {
    withCandidateProcessEnvironment(sandbox, () => {
      const before = readFrozenToolingCensus(sandbox.root, fixturePath);
      assert.equal(before.fixtureTracked, false);

      const fixtureOid = writeCandidateBlob(
        sandbox,
        "// @purpose Exercises candidate-index census derivation.\n" +
          "// @status ACTIVE\n",
      );
      updateCandidateEntry(sandbox, fixturePath, "100644", fixtureOid);

      const added = readFrozenToolingCensus(sandbox.root, fixturePath);
      assert.equal(added.fixtureTracked, true);
      assert.equal(added.generatorCount, before.generatorCount + 1);
      assert.equal(added.independentCount, before.independentCount + 1);

      const remove = spawnSync(
        "git",
        ["update-index", "--force-remove", "--", fixturePath],
        { cwd: sandbox.root, env: sandbox.env, encoding: "utf8" },
      );
      assert.equal(remove.status, 0, remove.stderr);

      const restored = readFrozenToolingCensus(sandbox.root, fixturePath);
      assert.equal(restored.fixtureTracked, false);
      assert.equal(restored.generatorCount, before.generatorCount);
      assert.equal(restored.independentCount, before.independentCount);
      t.diagnostic(
        `derived census counts: ${before.generatorCount}/${before.independentCount} -> ` +
          `${added.generatorCount}/${added.independentCount} -> ` +
          `${restored.generatorCount}/${restored.independentCount}`,
      );
    });
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("A1a: sanctioned commands start at the closed candidate module graph", () => {
  const files = readTrackedFiles([
    LAUNCHER_REL,
    "Tools/generate-tooling-catalog.mjs",
    "Tools/lib/purpose-header.mjs",
    "package.json",
  ]);
  const launcher = files.get(LAUNCHER_REL);
  assert.match(
    launcher,
    /@purpose Binds and materializes the candidate-index/u,
  );
  assert.match(launcher, /@status ACTIVE/u);
  assert.match(
    launcher,
    /const MODULE_GRAPH = Object\.freeze\(\[\s*ENTRY_PATH,\s*"Tools\/lib\/purpose-header\.mjs",\s*\]\)/u,
  );
  assert.match(launcher, /const STRIPPED_NODE_ENV = Object\.freeze/u);
  assert.match(launcher, /randomBytes\(32\)\.toString\("hex"\)/u);
  assert.match(launcher, /stdio: \["ignore", "pipe", "pipe", "pipe"\]/u);
  assert.match(
    launcher,
    /validateCompletionReceipt\([\s\S]*result\.output\?\.\[RECEIPT_FD\]/u,
  );

  const localImports = new Set();
  const expression =
    /\bimport\s+(?:(?:[\s\S]*?)\s+from\s+)?["'](\.[^"'\r\n]+)["']/gu;
  for (const pathname of [
    "Tools/generate-tooling-catalog.mjs",
    "Tools/lib/purpose-header.mjs",
  ]) {
    const source = files.get(pathname);
    for (const match of source.matchAll(expression)) {
      localImports.add(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(pathname), match[1]),
        ),
      );
    }
  }
  assert.deepEqual([...localImports], ["Tools/lib/purpose-header.mjs"]);

  const scripts = JSON.parse(files.get("package.json")).scripts;
  assert.equal(scripts["generate-tooling-catalog"], `node ${LAUNCHER_REL}`);
  assert.equal(
    scripts["verify-tooling-catalog"],
    `node ${LAUNCHER_REL} --check`,
  );
});

test("A1a2: direct generator execution cannot bypass the trust boundary", () => {
  const env = { ...process.env };
  for (const name of [
    "TOOLING_CATALOG_CANDIDATE_RUNTIME",
    "TOOLING_CATALOG_TRUSTED_LAUNCHER",
  ]) {
    delete env[name];
  }
  const result = spawnSync(process.execPath, [GENERATOR, "--check"], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /direct execution is unsupported/u);
});

test("A1a3: undeclared or computed candidate imports are STRUCTURAL", () => {
  const undeclared = candidateIndexMutant(
    "Tools/generate-tooling-catalog.mjs",
    (source) =>
      source.replace(
        'from "./lib/purpose-header.mjs";',
        'from "./lib/undeclared-header.mjs";',
      ),
  );
  assert.equal(undeclared.status, 3, undeclared.stderr);
  assert.match(undeclared.stderr, /imports undeclared/u);

  const computed = candidateIndexMutant(
    "Tools/generate-tooling-catalog.mjs",
    (source) => `${source}\nimport("./lib/" + "purpose-header.mjs");\n`,
  );
  assert.equal(computed.status, 3, computed.stderr);
  assert.match(computed.stderr, /computed dynamic import/u);

  const inverse = createCandidateSandbox();
  try {
    const result = runCandidate(inverse);
    assertCensusCurrent(result);
  } finally {
    rmSync(inverse.root, { recursive: true, force: true });
  }
});

test(
  "A1a4: Node preload, import, loader, and resolution startup state fails closed",
  { timeout: 120_000 },
  () => {
    const sandbox = createCandidateSandbox();
    try {
      const cleanEnv = { ...sandbox.env };
      for (const name of Object.keys(cleanEnv)) {
        if (
          ["NODE_OPTIONS", "NODE_PATH"].includes(name.toUpperCase()) ||
          name === "TOOLING_CATALOG_TRUSTED_LAUNCHER"
        ) {
          delete cleanEnv[name];
        }
      }

      const startupMutants = [
        {
          extension: "cjs",
          name: "preload",
          option(file) {
            return `--require=${file}`;
          },
          source:
            `const { appendFileSync } = require("node:fs");\n` +
            `appendFileSync(process.env.CATALOG_STARTUP_SENTINEL, process.env.TOOLING_CATALOG_TRUSTED_LAUNCHER === "1" ? "candidate\\n" : "launcher\\n");\n` +
            `if (process.env.TOOLING_CATALOG_TRUSTED_LAUNCHER === "1") process.exit(0);\n`,
        },
        {
          extension: "mjs",
          name: "import",
          option(file) {
            return `--import=${pathToFileURL(file).href}`;
          },
          source:
            `import { appendFileSync } from "node:fs";\n` +
            `appendFileSync(process.env.CATALOG_STARTUP_SENTINEL, process.env.TOOLING_CATALOG_TRUSTED_LAUNCHER === "1" ? "candidate\\n" : "launcher\\n");\n` +
            `if (process.env.TOOLING_CATALOG_TRUSTED_LAUNCHER === "1") process.exit(0);\n`,
        },
      ];
      for (const mutant of startupMutants) {
        const modulePath = path.join(
          sandbox.root,
          `${mutant.name}.${mutant.extension}`,
        );
        const sentinel = path.join(sandbox.root, `${mutant.name}.sentinel`);
        const skippedEntry = path.join(
          sandbox.root,
          `${mutant.name}.entry-ran`,
        );
        writeFileSync(modulePath, mutant.source);
        const nodeOptions = mutant.option(modulePath);

        const active = spawnSync(
          process.execPath,
          [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(skippedEntry)}, "ran")`,
          ],
          {
            cwd: ROOT,
            env: {
              ...cleanEnv,
              CATALOG_STARTUP_SENTINEL: sentinel,
              NODE_OPTIONS: nodeOptions,
              TOOLING_CATALOG_TRUSTED_LAUNCHER: "1",
            },
            encoding: "utf8",
          },
        );
        assert.equal(active.status, 0, `${mutant.name}: ${active.stderr}`);
        assert.equal(
          existsSync(skippedEntry),
          false,
          `${mutant.name} did not terminate before the candidate entry`,
        );
        assert.equal(readFileSync(sentinel, "utf8"), "candidate\n");

        const rejected = spawnSync(process.execPath, [SCRIPT, "--check"], {
          cwd: ROOT,
          env: {
            ...cleanEnv,
            CATALOG_STARTUP_SENTINEL: sentinel,
            NODE_OPTIONS: nodeOptions,
          },
          encoding: "utf8",
        });
        assert.equal(rejected.status, 3, `${mutant.name}: ${rejected.stderr}`);
        assert.equal(rejected.stdout, "");
        assert.match(rejected.stderr, /forbidden inherited Node startup/u);
        assert.match(readFileSync(sentinel, "utf8"), /launcher\n$/u);
      }

      const loaderPath = path.join(sandbox.root, "startup-loader.mjs");
      const loaderSentinel = path.join(sandbox.root, "loader.sentinel");
      writeFileSync(
        loaderPath,
        `import { appendFileSync } from "node:fs";\n` +
          `appendFileSync(process.env.CATALOG_STARTUP_SENTINEL, "loader\\n");\n` +
          `export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); }\n`,
      );
      const loaderOptions = `--experimental-loader=${pathToFileURL(loaderPath).href}`;
      const loaderActive = spawnSync(process.execPath, ["-e", "void 0"], {
        cwd: ROOT,
        env: {
          ...cleanEnv,
          CATALOG_STARTUP_SENTINEL: loaderSentinel,
          NODE_OPTIONS: loaderOptions,
        },
        encoding: "utf8",
      });
      assert.equal(loaderActive.status, 0, loaderActive.stderr);
      assert.match(readFileSync(loaderSentinel, "utf8"), /loader/u);
      const loaderRejected = spawnSync(process.execPath, [SCRIPT, "--check"], {
        cwd: ROOT,
        env: {
          ...cleanEnv,
          CATALOG_STARTUP_SENTINEL: loaderSentinel,
          NODE_OPTIONS: loaderOptions,
        },
        encoding: "utf8",
      });
      assert.equal(loaderRejected.status, 3, loaderRejected.stderr);
      assert.equal(loaderRejected.stdout, "");
      assert.match(loaderRejected.stderr, /forbidden inherited Node startup/u);

      const nodePathRoot = path.join(sandbox.root, "node-path");
      const nodePathModule = path.join(
        nodePathRoot,
        "catalog-node-path-mutant",
        "index.js",
      );
      const nodePathSentinel = path.join(sandbox.root, "node-path.sentinel");
      mkdirSync(path.dirname(nodePathModule), { recursive: true });
      writeFileSync(
        nodePathModule,
        `require("node:fs").writeFileSync(process.env.CATALOG_STARTUP_SENTINEL, "resolved");\n`,
      );
      const resolutionActive = spawnSync(
        process.execPath,
        ["-e", 'require("catalog-node-path-mutant")'],
        {
          cwd: ROOT,
          env: {
            ...cleanEnv,
            CATALOG_STARTUP_SENTINEL: nodePathSentinel,
            NODE_PATH: nodePathRoot,
          },
          encoding: "utf8",
        },
      );
      assert.equal(resolutionActive.status, 0, resolutionActive.stderr);
      assert.equal(readFileSync(nodePathSentinel, "utf8"), "resolved");
      const resolutionRejected = spawnSync(
        process.execPath,
        [SCRIPT, "--check"],
        {
          cwd: ROOT,
          env: { ...cleanEnv, NODE_PATH: nodePathRoot },
          encoding: "utf8",
        },
      );
      assert.equal(resolutionRejected.status, 3, resolutionRejected.stderr);
      assert.equal(resolutionRejected.stdout, "");
      assert.match(resolutionRejected.stderr, /NODE_PATH/u);

      const inverse = spawnSync(process.execPath, [SCRIPT, "--check"], {
        cwd: ROOT,
        env: cleanEnv,
        encoding: "utf8",
      });
      assertCensusCurrent(inverse);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

test(
  "A1a5: completion receipt rejects empty success and forged envelopes before output",
  { timeout: 120_000 },
  () => {
    const generatorPath = "Tools/generate-tooling-catalog.mjs";
    const mutants = [
      [
        "empty success",
        (source) => source.replace(/^(#![^\n]*\n)/u, "$1process.exit(0);\n"),
        /no completion receipt/u,
      ],
      [
        "missing receipt",
        (source) =>
          source.replace(
            "    publishCompletionReceipt(status);",
            "    void status; // receipt deliberately suppressed",
          ),
        /no completion receipt/u,
      ],
      [
        "forged schema",
        (source) =>
          source.replace(
            'const RECEIPT_SCHEMA = "tooling-catalog-completion-v1";',
            'const RECEIPT_SCHEMA = "tooling-catalog-completion-forged";',
          ),
        /does not bind/u,
      ],
      [
        "mismatched challenge",
        (source) =>
          source.replace(
            "      challenge,\n      schema:",
            '      challenge: "0".repeat(64),\n      schema:',
          ),
        /does not bind/u,
      ],
      [
        "mismatched subject",
        (source) =>
          source.replace(
            "      status,\n      subject,",
            '      status,\n      subject: "0".repeat(64),',
          ),
        /does not bind/u,
      ],
      [
        "mismatched verdict",
        (source) =>
          source.replace(
            "      schema: RECEIPT_SCHEMA,\n      status,",
            "      schema: RECEIPT_SCHEMA,\n      status: status === 0 ? 1 : 0,",
          ),
        /does not bind/u,
      ],
    ];
    for (const [name, mutate, diagnostic] of mutants) {
      const result = candidateIndexMutant(generatorPath, mutate);
      assert.equal(result.status, 3, `${name}: ${result.stderr}`);
      assert.equal(result.stdout, "", `${name}: unverified stdout escaped`);
      assert.match(result.stderr, diagnostic, name);
    }

    const inverse = createCandidateSandbox();
    try {
      const result = runCandidate(inverse);
      assertCensusCurrent(result);
    } finally {
      rmSync(inverse.root, { recursive: true, force: true });
    }
  },
);

test("A1b: ignored and unrelated untracked files cannot become census subjects", () => {
  const files = listToolingFiles();
  assert.ok(
    files.every((file) => !file.includes("/output/")),
    "an ignored run-output helper entered the tracked census",
  );
  assert.ok(
    files.every((file) => !file.includes("/work/")),
    "an ignored bake-work helper entered the tracked census",
  );
});

test("A1c: census content comes from the candidate index", () => {
  const tracked = readTrackedFiles(["Tools/generate-tooling-catalog.mjs"]);
  assert.equal(tracked.size, 1);
  assert.match(
    tracked.get("Tools/generate-tooling-catalog.mjs"),
    /@purpose Regenerates the TOOLING_CATALOG census/,
  );
});

test("A1d: newline-bearing tracked paths cannot corrupt blob framing", () => {
  const rel = "Tools/line\nbreak.mjs";
  const oid = "0123456789abcdef0123456789abcdef01234567";
  const entries = parseCandidateIndexEntries(`100644 ${oid} 0\t${rel}\0`, [
    rel,
  ]);
  assert.deepEqual(entries.get(rel), { mode: "100644", oid });
});

test("A1d2: slash and literal-backslash Git paths remain distinct", () => {
  const slash = "Tools/literal/name.mjs";
  const backslash = "Tools/literal\\name.mjs";
  const slashOid = "0123456789abcdef0123456789abcdef01234567";
  const backslashOid = "89abcdef0123456789abcdef0123456789abcdef";
  const raw =
    `100644 ${slashOid} 0\t${slash}\0` +
    `100644 ${backslashOid} 0\t${backslash}\0`;
  const entries = parseCandidateIndexEntries(raw, [slash, backslash]);
  assert.deepEqual(entries.get(slash), { mode: "100644", oid: slashOid });
  assert.deepEqual(entries.get(backslash), {
    mode: "100644",
    oid: backslashOid,
  });
  assert.deepEqual(
    parseTrackedPathList(`${slash}\0${backslash}\0`),
    [backslash, slash].sort(),
  );
  const byPath = new Set([slash, backslash]);
  const byBase = new Map([
    ["name.mjs", [slash]],
    ["literal\\name.mjs", [backslash]],
  ]);
  assert.equal(
    resolveReferenceToken("Tools/source.mjs", backslash, byPath, byBase),
    backslash,
  );
});

test("A1d3: NUL-framed history preserves newline and backslash path identities", () => {
  const newline = "Tools/line\nbreak.mjs";
  const backslash = "Tools/literal\\name.mjs";
  const output = Buffer.from(
    `\0\u00012026-08-17\0\u0002\n${newline}\0${backslash}\0`,
    "utf8",
  );
  const dates = parseLastTouchHistory(output);
  assert.equal(dates.get(newline), "2026-08-17");
  assert.equal(dates.get(backslash), "2026-08-17");
  assert.deepEqual([...dates.keys()], [newline, backslash]);
});

test("A1e: inaccessible index objects fail closed without catalog output", () => {
  const missingObjects = path.join(
    tmpdir(),
    `catalog-missing-objects-${process.pid}-${Date.now()}`,
  );
  const result = spawnSync(process.execPath, [SCRIPT, "--stdout"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_OBJECT_DIRECTORY: missingObjects },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /(?:generate-tooling-catalog-launcher: ERROR|cannot (?:freeze the candidate subject|bind the candidate runtime\/catalog|construct the candidate census))/u,
  );
});

test("A1f: HTML harnesses are scanned as inbound-reference sources", () => {
  assert.equal(isReferenceSourcePath("Tools/example/harness.html"), true);
  assert.equal(isReferenceSourcePath("Tools/example/image.png"), false);
});

test("A1g: executing generator and parser are bound to candidate-index blobs", () => {
  assert.deepEqual(runtimeCandidateBindingReasons(), []);
  const forged = runtimeCandidateBindingReasons(
    ["Tools/generate-tooling-catalog.mjs"],
    ROOT,
    new Map([
      ["Tools/generate-tooling-catalog.mjs", Buffer.from("forged runtime")],
    ]),
  );
  assert.equal(forged.length, 1);
  assert.match(forged[0], /module-initialization bytes do not match/u);
});

test("A1g2: raw launcher bytes defeat clean-filter trust laundering", () => {
  const sandbox = createCandidateSandbox();
  try {
    const launcherOid = candidatePathOid(sandbox, LAUNCHER_REL);
    const canonicalLauncher = readCandidateObject(sandbox, launcherOid);
    const forgedLauncher = `${canonicalLauncher}\n// clean-filter launcher byte mutant\n`;
    assert.notEqual(
      forgedLauncher,
      canonicalLauncher,
      "launcher mutant did not change bytes",
    );
    const catalogPath = "migration_doc/TOOLING_CATALOG.md";
    const catalog = readCandidateObject(
      sandbox,
      candidatePathOid(sandbox, catalogPath),
    );
    updateCandidatePath(
      sandbox,
      catalogPath,
      catalog.replace("Columns: file", "Columns: stale file"),
    );

    const generator = readCandidateObject(
      sandbox,
      candidatePathOid(sandbox, "Tools/generate-tooling-catalog.mjs"),
    );
    const runtime = createRuntimeWorktree(
      sandbox,
      generator,
      undefined,
      forgedLauncher,
    );
    writeFileSync(
      path.join(runtime.worktree, ".gitattributes"),
      `${LAUNCHER_REL} filter=catalog-launder\n`,
    );
    const configured = spawnSync(
      "git",
      [
        "config",
        "filter.catalog-launder.clean",
        `git cat-file blob ${launcherOid}`,
      ],
      { cwd: ROOT, env: runtime.env, encoding: "utf8" },
    );
    assert.equal(configured.status, 0, configured.stderr);
    const laundered = spawnSync(
      "git",
      ["hash-object", "--stdin", `--path=${LAUNCHER_REL}`],
      {
        cwd: runtime.worktree,
        env: runtime.env,
        input: forgedLauncher,
        encoding: "utf8",
      },
    );
    assert.equal(laundered.status, 0, laundered.stderr);
    assert.equal(
      laundered.stdout.trim(),
      launcherOid,
      "clean filter is inactive",
    );

    const attacked = runRuntimeWorktree(runtime);
    assert.equal(attacked.status, 3, attacked.stderr);
    assert.match(attacked.stderr, /startup bytes do not match/u);

    writeFileSync(runtime.launcherPath, canonicalLauncher);
    const inverse = runRuntimeWorktree(runtime);
    assert.equal(inverse.status, 1, inverse.stderr);
    assert.match(inverse.stderr, /DRIFTED/u);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test(
  "A1g3: replacing a loaded generator cannot erase its initialization identity",
  { timeout: 30_000 },
  async () => {
    const sandbox = createCandidateSandbox();
    const snapshotParent = path.join(sandbox.root, "runtime-snapshots");
    mkdirSync(snapshotParent);
    try {
      const generatorPath = "Tools/generate-tooling-catalog.mjs";
      const canonical = readCandidateObject(
        sandbox,
        candidatePathOid(sandbox, generatorPath),
      );
      const forged = canonical.replace(
        "if (committed === regenerated) {",
        "if (true) {",
      );
      assert.notEqual(forged, canonical);
      const catalogPath = "migration_doc/TOOLING_CATALOG.md";
      const catalog = readCandidateObject(
        sandbox,
        candidatePathOid(sandbox, catalogPath),
      );
      updateCandidatePath(
        sandbox,
        catalogPath,
        catalog.replace("Columns: file", "Columns: stale file"),
      );
      const runtime = createRuntimeWorktree(sandbox, forged);

      const unchanged = runDirectRuntimeGenerator(runtime);
      assert.equal(unchanged.status, 3, unchanged.stderr);
      assert.match(unchanged.stderr, /module-initialization bytes/u);

      writeFileSync(runtime.generatorPath, canonical);
      const canonicalFromStart = runDirectRuntimeGenerator(runtime);
      assert.equal(canonicalFromStart.status, 1, canonicalFromStart.stderr);
      assert.match(canonicalFromStart.stderr, /DRIFTED/u);

      writeFileSync(runtime.generatorPath, forged);
      const child = spawn(
        process.execPath,
        [runtime.generatorPath, "--check"],
        {
          cwd: runtime.worktree,
          env: {
            ...runtime.env,
            TEMP: snapshotParent,
            TMP: snapshotParent,
            TOOLING_CATALOG_TRUSTED_LAUNCHER: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const childResult = waitForChild(child);
      await waitForPrivateSnapshot(snapshotParent);
      writeFileSync(runtime.generatorPath, canonical);
      const raced = await childResult;
      assert.equal(raced.signal, null);
      assert.equal(raced.status, 3, raced.stderr);
      assert.match(raced.stderr, /module-initialization bytes/u);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

test("A1g4: worktree early exit and import side effects run only after binding", () => {
  const sandbox = createCandidateSandbox();
  try {
    const catalogPath = "migration_doc/TOOLING_CATALOG.md";
    const catalog = readCandidateObject(
      sandbox,
      candidatePathOid(sandbox, catalogPath),
    );
    updateCandidatePath(
      sandbox,
      catalogPath,
      catalog.replace("Columns: file", "Columns: stale file"),
    );

    const generator = readCandidateObject(
      sandbox,
      candidatePathOid(sandbox, "Tools/generate-tooling-catalog.mjs"),
    );
    const parser = readCandidateObject(
      sandbox,
      candidatePathOid(sandbox, "Tools/lib/purpose-header.mjs"),
    );
    const earlyExit = generator.replace(
      /^(#![^\n]*\n)/u,
      "$1process.exit(0);\n",
    );
    assert.notEqual(earlyExit, generator);
    const sentinel = path.join(sandbox.root, "worktree-parser-ran.txt");
    const sideEffect =
      `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(sentinel)}, "ran");\n` +
      `process.exit(0);\n${parser}`;
    const runtime = createRuntimeWorktree(sandbox, earlyExit, sideEffect);

    const attacked = runRuntimeWorktree(runtime);
    assert.equal(attacked.status, 1, attacked.stderr);
    assert.match(attacked.stderr, /DRIFTED/u);
    assert.equal(existsSync(sentinel), false);

    writeFileSync(runtime.generatorPath, generator);
    writeFileSync(runtime.parserPath, parser);
    const inverse = runRuntimeWorktree(runtime);
    assert.equal(inverse.status, 1, inverse.stderr);
    assert.match(inverse.stderr, /DRIFTED/u);
    assert.equal(existsSync(sentinel), false);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("A1h: a concurrent catalog edit aborts write mode before replacement", () => {
  let writes = 0;
  assert.equal(
    writeCatalogIfUnchanged(
      "initial",
      "replacement",
      () => "concurrent edit",
      () => {
        writes++;
      },
    ),
    false,
  );
  assert.equal(writes, 0);
  let stored = "initial";
  assert.equal(
    writeCatalogIfUnchanged(
      "initial",
      "replacement",
      () => stored,
      (value) => {
        stored = value;
      },
    ),
    true,
  );
  assert.equal(stored, "replacement");
});

test("A1i: candidate catalog and trust-boundary identity control the verdict", () => {
  const staleCatalog = candidateIndexMutant(
    "migration_doc/TOOLING_CATALOG.md",
    (source) => source.replace("Columns: file", "Columns: stale file"),
  );
  assert.equal(staleCatalog.status, 1);
  assert.match(staleCatalog.stderr, /DRIFTED/u);

  const staleLauncher = candidateIndexMutant(
    LAUNCHER_REL,
    (source) => `${source}\n// stale candidate launcher\n`,
  );
  assert.equal(staleLauncher.status, 3);
  assert.match(staleLauncher.stderr, /startup bytes do not match/u);

  const staleGenerator = candidateIndexMutant(
    "Tools/generate-tooling-catalog.mjs",
    (source) => `${source}\n// stale candidate implementation\n`,
  );
  assertCensusCurrent(staleGenerator);

  const staleParser = candidateIndexMutant(
    "Tools/lib/purpose-header.mjs",
    (source) => `${source}\n// stale candidate parser\n`,
  );
  assertCensusCurrent(staleParser);
});

test("A1j: the private candidate snapshot restores environment and cleans up", () => {
  const before = process.env.GIT_INDEX_FILE;
  const beforeNoReplace = process.env.GIT_NO_REPLACE_OBJECTS;
  process.env.GIT_NO_REPLACE_OBJECTS = "prior-test-value";
  let privateIndex;
  let privateRoot;
  try {
    const result = withFrozenCandidateIndex((subject) => {
      privateIndex = subject.privateIndex;
      privateRoot = subject.privateRoot;
      assert.equal(process.env.GIT_INDEX_FILE, privateIndex);
      assert.equal(process.env.GIT_NO_REPLACE_OBJECTS, "1");
      assert.equal(existsSync(privateIndex), true);
      return 17;
    });
    assert.equal(result, 17);
    assert.equal(process.env.GIT_INDEX_FILE, before);
    assert.equal(process.env.GIT_NO_REPLACE_OBJECTS, "prior-test-value");
    assert.equal(existsSync(privateRoot), false);

    let thrownRoot;
    assert.throws(
      () =>
        withFrozenCandidateIndex((subject) => {
          thrownRoot = subject.privateRoot;
          assert.equal(process.env.GIT_NO_REPLACE_OBJECTS, "1");
          throw new Error("injected callback failure");
        }),
      /injected callback failure/u,
    );
    assert.equal(process.env.GIT_INDEX_FILE, before);
    assert.equal(process.env.GIT_NO_REPLACE_OBJECTS, "prior-test-value");
    assert.equal(existsSync(thrownRoot), false);
  } finally {
    if (beforeNoReplace === undefined) {
      delete process.env.GIT_NO_REPLACE_OBJECTS;
    } else {
      process.env.GIT_NO_REPLACE_OBJECTS = beforeNoReplace;
    }
  }
});

test(
  "A1k: candidate-index movement during the census is STRUCTURAL with no stdout",
  { timeout: 30_000 },
  async () => {
    const sandbox = createCandidateSandbox();
    const snapshotParent = path.join(sandbox.root, "snapshots");
    mkdirSync(snapshotParent);
    try {
      const child = spawn(process.execPath, [SCRIPT, "--check"], {
        cwd: ROOT,
        env: {
          ...sandbox.env,
          TEMP: snapshotParent,
          TMP: snapshotParent,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const childResult = waitForChild(child);
      await waitForPrivateSnapshot(snapshotParent);

      const pathname = `Tools/catalog-index-race-${process.pid}-${Date.now()}.mjs`;
      const source =
        "// @purpose Candidate-index race sentinel.\n// @status ACTIVE\n";
      const hash = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: ROOT,
        env: sandbox.env,
        input: source,
        encoding: "utf8",
      });
      assert.equal(hash.status, 0, hash.stderr);
      const update = spawnSync(
        "git",
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${hash.stdout.trim()},${pathname}`,
        ],
        { cwd: ROOT, env: sandbox.env, encoding: "utf8" },
      );
      assert.equal(update.status, 0, update.stderr);

      const result = await childResult;
      assert.equal(result.signal, null);
      assert.equal(result.status, 3, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        /candidate Git index changed (?:during census|while the materialized runtime executed)/u,
      );
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

test(
  "A1l: candidate HEAD movement blocks stdout publication",
  { timeout: 30_000 },
  async () => {
    const sandbox = createCandidateSandbox();
    const snapshotParent = path.join(sandbox.root, "snapshots");
    mkdirSync(snapshotParent);
    try {
      const child = spawn(process.execPath, [SCRIPT, "--stdout"], {
        cwd: ROOT,
        env: {
          ...sandbox.env,
          TEMP: snapshotParent,
          TMP: snapshotParent,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const childResult = waitForChild(child);
      await waitForPrivateSnapshot(snapshotParent);
      const parent = spawnSync("git", ["rev-parse", "HEAD^"], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assert.equal(parent.status, 0, parent.stderr);
      const move = spawnSync(
        "git",
        ["update-ref", "refs/heads/catalog-candidate", parent.stdout.trim()],
        { cwd: ROOT, env: sandbox.env, encoding: "utf8" },
      );
      assert.equal(move.status, 0, move.stderr);

      const result = await childResult;
      assert.equal(result.signal, null);
      assert.equal(result.status, 3, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /candidate HEAD changed during census/u);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

test("A1m: split and skip-worktree candidate indexes materialize as full snapshots", () => {
  for (const variant of ["split", "skip-worktree"]) {
    const sandbox = createCandidateSandbox();
    try {
      const args =
        variant === "split"
          ? ["update-index", "--split-index"]
          : ["update-index", "--skip-worktree", "Tools/lib/purpose-header.mjs"];
      const configure = spawnSync("git", args, {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assert.equal(configure.status, 0, configure.stderr);
      if (variant === "split") {
        assert.ok(
          readdirSync(sandbox.gitDir).some((name) =>
            name.startsWith("sharedindex."),
          ),
          "split-index fixture did not create its shared index",
        );
      }
      const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assertCensusCurrent(result, variant);
      const intact = spawnSync("git", ["ls-files", "--stage", "-z"], {
        cwd: ROOT,
        env: sandbox.env,
      });
      assert.equal(
        intact.status,
        0,
        `${variant}: ${intact.stderr?.toString("utf8")}`,
      );
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
});

test(
  "A1m2: a true sparse index is expanded privately and remains byte-identical",
  { timeout: 120_000 },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "catalog-sparse-index-"));
    const clone = path.join(root, "repo");
    const cleanEnv = { ...process.env };
    for (const name of [
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_DIR",
      "GIT_INDEX_FILE",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OBJECT_DIRECTORY",
      "GIT_REPLACE_REF_BASE",
      "GIT_SHALLOW_FILE",
      "GIT_WORK_TREE",
    ]) {
      delete cleanEnv[name];
    }
    try {
      const cloned = spawnSync(
        "git",
        ["clone", "--no-checkout", "--shared", ROOT, clone],
        { cwd: root, env: cleanEnv, encoding: "utf8" },
      );
      assert.equal(cloned.status, 0, cloned.stderr);
      for (const args of [
        ["-C", clone, "read-tree", "HEAD"],
        ["-C", clone, "sparse-checkout", "init", "--cone", "--sparse-index"],
        [
          "-C",
          clone,
          "sparse-checkout",
          "set",
          "Tools",
          "scripts",
          "migration_doc",
          ".husky",
        ],
      ]) {
        const configured = spawnSync("git", args, {
          cwd: root,
          env: cleanEnv,
          encoding: "utf8",
        });
        assert.equal(configured.status, 0, configured.stderr);
      }

      const sparseBefore = spawnSync(
        "git",
        ["ls-files", "--sparse", "--stage"],
        { cwd: clone, env: cleanEnv, encoding: "utf8" },
      );
      assert.equal(sparseBefore.status, 0, sparseBefore.stderr);
      assert.match(sparseBefore.stdout, /^040000 [0-9a-f]{40,64} 0\t.+\/$/mu);
      for (const pathname of [
        LAUNCHER_REL,
        "Tools/generate-tooling-catalog.mjs",
        "Tools/generate-tooling-catalog.spec.mjs",
        "migration_doc/TOOLING_CATALOG.md",
        "package.json",
      ]) {
        const hash = spawnSync(
          "git",
          [
            "hash-object",
            "-w",
            `--path=${pathname}`,
            path.join(ROOT, ...pathname.split("/")),
          ],
          { cwd: clone, env: cleanEnv, encoding: "utf8" },
        );
        assert.equal(hash.status, 0, hash.stderr);
        const update = spawnSync(
          "git",
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `100644,${hash.stdout.trim()},${pathname}`,
          ],
          { cwd: clone, env: cleanEnv, encoding: "utf8" },
        );
        assert.equal(update.status, 0, update.stderr);
      }
      const sparse = spawnSync("git", ["ls-files", "--sparse", "--stage"], {
        cwd: clone,
        env: cleanEnv,
        encoding: "utf8",
      });
      assert.equal(sparse.status, 0, sparse.stderr);
      assert.match(sparse.stdout, /^040000 [0-9a-f]{40,64} 0\t.+\/$/mu);

      const indexPath = path.join(clone, ".git", "index");
      const before = readFileSync(indexPath);
      const candidateEnv = {
        ...cleanEnv,
        GIT_DIR: path.join(clone, ".git"),
        GIT_WORK_TREE: ROOT,
      };
      const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
        cwd: ROOT,
        env: candidateEnv,
        encoding: "utf8",
      });
      assertCensusCurrent(result);
      assert.deepEqual(readFileSync(indexPath), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("A1n: replacement objects cannot launder catalog or runtime blobs", () => {
  {
    const sandbox = createCandidateSandbox();
    try {
      const pathname = "migration_doc/TOOLING_CATALOG.md";
      const currentOid = candidatePathOid(sandbox, pathname);
      const current = readCandidateObject(sandbox, currentOid);
      const stale = current.replace("Columns: file", "Columns: stale file");
      assert.notEqual(stale, current);
      const staleOid = updateCandidatePath(sandbox, pathname, stale);
      installReplacement(sandbox, staleOid, currentOid);

      const replaced = spawnSync("git", ["cat-file", "blob", staleOid], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assert.equal(replaced.status, 0, replaced.stderr);
      assert.equal(replaced.stdout, current, "replacement fixture is inactive");

      const result = runCandidate(sandbox);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /DRIFTED/u);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }

  {
    const sandbox = createCandidateSandbox();
    try {
      const generatorPath = "Tools/generate-tooling-catalog.mjs";
      const generatorOid = candidatePathOid(sandbox, generatorPath);
      const generator = readCandidateObject(sandbox, generatorOid);
      const currentPurpose =
        "Regenerates the TOOLING_CATALOG census section from @purpose/@status headers, git freshness and inbound refs; --check fails on drift.";
      const forgedPurpose = "Forged replacement-object catalog purpose.";
      const forgedGenerator = generator.replace(currentPurpose, forgedPurpose);
      assert.notEqual(forgedGenerator, generator);
      const forgedGeneratorOid = writeCandidateBlob(sandbox, forgedGenerator);
      installReplacement(sandbox, generatorOid, forgedGeneratorOid);

      const catalogPath = "migration_doc/TOOLING_CATALOG.md";
      const catalog = readCandidateObject(
        sandbox,
        candidatePathOid(sandbox, catalogPath),
      );
      const forgedCatalog = catalog.replace(currentPurpose, forgedPurpose);
      assert.notEqual(forgedCatalog, catalog);
      updateCandidatePath(sandbox, catalogPath, forgedCatalog);

      const result = runCandidate(sandbox);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /DRIFTED/u);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }

  {
    const sandbox = createCandidateSandbox();
    try {
      const launcherOid = candidatePathOid(sandbox, LAUNCHER_REL);
      const launcher = readCandidateObject(sandbox, launcherOid);
      const forged = `${launcher}\n// replacement-object launcher mutant\n`;
      assert.notEqual(forged, launcher);
      const forgedOid = writeCandidateBlob(sandbox, forged);
      installReplacement(sandbox, launcherOid, forgedOid);

      const replaced = spawnSync("git", ["cat-file", "blob", launcherOid], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assert.equal(replaced.status, 0, replaced.stderr);
      assert.equal(replaced.stdout, forged, "launcher replacement is inactive");

      const result = runCandidate(sandbox);
      assertCensusCurrent(result);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
});

test("A1o: replacement history is ignored; grafted or shallow history is STRUCTURAL", () => {
  {
    const sandbox = createCandidateSandbox();
    try {
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      const parent = spawnSync("git", ["rev-parse", "HEAD^"], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assert.equal(head.status, 0, head.stderr);
      assert.equal(parent.status, 0, parent.stderr);
      installReplacement(sandbox, head.stdout.trim(), parent.stdout.trim());
      const replacedCount = spawnSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      const canonicalCount = spawnSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: ROOT,
        env: { ...sandbox.env, GIT_NO_REPLACE_OBJECTS: "1" },
        encoding: "utf8",
      });
      assert.equal(replacedCount.status, 0, replacedCount.stderr);
      assert.equal(canonicalCount.status, 0, canonicalCount.stderr);
      assert.notEqual(replacedCount.stdout, canonicalCount.stdout);
      const result = runCandidate(sandbox);
      assertCensusCurrent(result);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }

  for (const variant of ["graft", "shallow"]) {
    const sandbox = createCandidateSandbox();
    try {
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assert.equal(head.status, 0, head.stderr);
      const pathname =
        variant === "graft"
          ? path.join(sandbox.gitDir, "info", "grafts")
          : path.join(sandbox.gitDir, "shallow");
      writeFileSync(pathname, `${head.stdout.trim()}\n`);
      const result = runCandidate(sandbox, ["--stdout"]);
      assert.equal(result.status, 3, `${variant}: ${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(variant, "u"));
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
});

test(
  "A1o2: history becoming grafted after snapshot blocks stdout publication",
  { timeout: 30_000 },
  async () => {
    const sandbox = createCandidateSandbox();
    const snapshotParent = path.join(sandbox.root, "snapshots");
    mkdirSync(snapshotParent);
    try {
      const child = spawn(process.execPath, [SCRIPT, "--stdout"], {
        cwd: ROOT,
        env: {
          ...sandbox.env,
          TEMP: snapshotParent,
          TMP: snapshotParent,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const childResult = waitForChild(child);
      await waitForPrivateSnapshot(snapshotParent);
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assert.equal(head.status, 0, head.stderr);
      writeFileSync(
        path.join(sandbox.gitDir, "info", "grafts"),
        `${head.stdout.trim()}\n`,
      );

      const result = await childResult;
      assert.equal(result.signal, null);
      assert.equal(result.status, 3, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /info\/grafts/u);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

test(
  "A1o3: isolated history defeats shallow and graft ABA during git log",
  { timeout: 120_000 },
  () => {
    const sandbox = createCandidateSandbox();
    try {
      const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assert.equal(headResult.status, 0, headResult.stderr);
      const head = headResult.stdout.trim();
      const catalogPath = "migration_doc/TOOLING_CATALOG.md";
      const catalog = readCandidateObject(
        sandbox,
        candidatePathOid(sandbox, catalogPath),
      );
      const catalogSplit = splitCatalog(catalog);
      assert.ok(catalogSplit !== null);

      const shallowPath = path.join(sandbox.gitDir, "shallow");
      writeFileSync(shallowPath, `${head}\n`);
      const attacked = withCandidateProcessEnvironment(sandbox, () =>
        renderCensus(collectCensus(head, sandbox.env), catalogSplit.eol),
      );
      rmSync(shallowPath, { force: true });
      const canonical = withCandidateProcessEnvironment(sandbox, () =>
        renderCensus(collectCensus(head, sandbox.env), catalogSplit.eol),
      );
      assert.notEqual(
        attacked,
        canonical,
        "shallow history did not alter dates",
      );
      const drift = describeDriftDetailed(attacked, canonical);
      assert.equal(drift.structural, false);
      assert.match(drift.lines[0], /of which [1-9]\d* differ only/u);

      updateCandidatePath(
        sandbox,
        catalogPath,
        `${catalogSplit.before}${attacked}${catalogSplit.after}`,
      );
      for (const variant of ["shallow", "graft"]) {
        const shim = installGitHistoryAbaShim(sandbox, head, variant);
        const abaAttacked = withCandidateProcessEnvironment(
          { env: shim.env },
          () => renderCensus(collectCensus(head, shim.env), catalogSplit.eol),
        );
        assert.equal(
          abaAttacked,
          attacked,
          `${variant} ABA shim did not alter mutable history`,
        );
        assert.equal(existsSync(shim.targetPath), false);

        const rejected = spawnSync(process.execPath, [SCRIPT, "--stdout"], {
          cwd: ROOT,
          env: shim.env,
          encoding: "utf8",
        });
        assert.equal(rejected.status, 3, `${variant}: ${rejected.stderr}`);
        assert.equal(rejected.stdout, "");
        assert.match(rejected.stderr, /forbidden inherited Node startup/u);
        assert.equal(
          existsSync(shim.attackLog),
          true,
          `${variant}: Git log shim was not reached`,
        );
        assert.equal(existsSync(shim.targetPath), false);

        const fixed = runCandidate(sandbox, ["--stdout"]);
        assert.equal(fixed.status, 0, `${variant}: ${fixed.stderr}`);
        assert.equal(fixed.stdout, `${canonical}${catalogSplit.eol}`);

        const attackedCheck = runCandidate(sandbox);
        assert.equal(
          attackedCheck.status,
          1,
          `${variant}: ${attackedCheck.stderr}`,
        );
        assert.match(attackedCheck.stderr, /of which [1-9]\d* differ only/u);
      }

      const canonicalControl = runCandidate(sandbox);
      assert.equal(canonicalControl.status, 1, canonicalControl.stderr);
      assert.match(canonicalControl.stderr, /of which [1-9]\d* differ only/u);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  },
);

test("A1p: missing catalog/runtime/parser candidate paths are STRUCTURAL", () => {
  for (const pathname of [
    "migration_doc/TOOLING_CATALOG.md",
    LAUNCHER_REL,
    "Tools/generate-tooling-catalog.mjs",
    "Tools/lib/purpose-header.mjs",
  ]) {
    const sandbox = createCandidateSandbox();
    try {
      const remove = spawnSync(
        "git",
        ["update-index", "--force-remove", "--", pathname],
        { cwd: ROOT, env: sandbox.env, encoding: "utf8" },
      );
      assert.equal(remove.status, 0, remove.stderr);
      const result = runCandidate(sandbox);
      assert.equal(result.status, 3, `${pathname}: ${result.stderr}`);
      assert.match(
        result.stderr,
        /(?:no stage-zero entry|required candidate paths are absent)/u,
      );
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
});

test("A1q: non-regular required and census paths are STRUCTURAL", () => {
  for (const pathname of [
    "migration_doc/TOOLING_CATALOG.md",
    LAUNCHER_REL,
    "Tools/generate-tooling-catalog.mjs",
    "Tools/lib/purpose-header.mjs",
    "Tools/generate-tooling-catalog.spec.mjs",
  ]) {
    const sandbox = createCandidateSandbox();
    try {
      const oid = candidatePathOid(sandbox, pathname);
      updateCandidateEntry(sandbox, pathname, "120000", oid);
      const result = runCandidate(sandbox);
      assert.equal(result.status, 3, `${pathname}: ${result.stderr}`);
      assert.match(result.stderr, /non-regular mode 120000/u);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }

  for (const pathname of [
    "migration_doc/TOOLING_CATALOG.md",
    LAUNCHER_REL,
    "Tools/generate-tooling-catalog.spec.mjs",
  ]) {
    const sandbox = createCandidateSandbox();
    try {
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assert.equal(head.status, 0, head.stderr);
      updateCandidateEntry(sandbox, pathname, "160000", head.stdout.trim());
      const result = runCandidate(sandbox);
      assert.equal(result.status, 3, `${pathname}: ${result.stderr}`);
      assert.match(result.stderr, /non-regular mode 160000/u);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
});

test("A1r: regular entries with corrupt objects are ERROR, not STRUCTURAL", () => {
  for (const pathname of [
    "migration_doc/TOOLING_CATALOG.md",
    LAUNCHER_REL,
    "Tools/generate-tooling-catalog.mjs",
    "Tools/lib/purpose-header.mjs",
    "Tools/generate-tooling-catalog.spec.mjs",
  ]) {
    const sandbox = createCandidateSandbox();
    try {
      const missingOid = "1".repeat(40);
      const absent = spawnSync("git", ["cat-file", "-e", missingOid], {
        cwd: ROOT,
        env: sandbox.env,
        encoding: "utf8",
      });
      assert.notEqual(
        absent.status,
        0,
        "corrupt-object fixture unexpectedly exists",
      );
      updateCandidateEntry(sandbox, pathname, "100644", missingOid);
      const result = runCandidate(sandbox);
      assert.equal(result.status, 2, `${pathname}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /STRUCTURAL/u);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
});

test("A1s: unrenderable raw Git identities are explicitly STRUCTURAL", () => {
  for (const pathname of ["Tools/literal\\name.mjs", "Tools/line\nbreak.mjs"]) {
    const sandbox = createCandidateSandbox();
    try {
      const oid = writeCandidateBlob(
        sandbox,
        "// @purpose Raw-path identity fixture.\n// @status ACTIVE\n",
      );
      updateCandidateEntryRaw(sandbox, pathname, "100644", oid);
      const result = runCandidate(sandbox);
      assert.equal(
        result.status,
        3,
        `${JSON.stringify(pathname)}: ${result.stderr}`,
      );
      assert.match(result.stderr, /cannot be represented losslessly/u);
      assert.ok(result.stderr.includes(JSON.stringify(pathname)));
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }

  const unrelated = createCandidateSandbox();
  try {
    const pathname = "packages/unrelated\\name.mjs";
    const oid = writeCandidateBlob(unrelated, "unrelated raw-path fixture\n");
    updateCandidateEntryRaw(unrelated, pathname, "100644", oid);
    const result = runCandidate(unrelated);
    assertCensusCurrent(result);
  } finally {
    rmSync(unrelated.root, { recursive: true, force: true });
  }
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
  assert.equal(
    splitCatalog(`${BEGIN_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}\n`),
    null,
  );
  assert.equal(
    splitCatalog(`${BEGIN_MARKER}\n${END_MARKER}\n${END_MARKER}\n`),
    null,
  );
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
      archivePlan: [],
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

test("D4: freshness-only drift is advisory; structural drift still fails", () => {
  // The freshness column reads a file's last COMMIT date, which only exists
  // after the touching commit lands, so the landing commit can never be
  // check-green on those rows. Freshness-only inequality is therefore an
  // advisory exit 0 (the Batch 1053 contract); anything structural fails.
  const before = ROW("a.mjs", "2026-08-01", "A.");
  const dateOnly = describeDriftDetailed(
    before,
    ROW("a.mjs", "2026-08-16", "A."),
  );
  assert.equal(dateOnly.structural, false);
  assert.deepEqual(dateOnly.freshnessOnlyPaths, ["a.mjs"]);
  assert.equal(
    catalogCheckExitCode(
      before,
      ROW("a.mjs", "2026-08-16", "A."),
      new Set(["a.mjs"]),
    ),
    0,
  );
  assert.equal(
    catalogCheckExitCode(
      before,
      ROW("a.mjs", "2026-08-16", "A."),
      new Set(["b.mjs"]),
    ),
    1,
  );
  assert.equal(
    catalogCheckExitCode(before, ROW("a.mjs", "2026-08-16", "A.")),
    1,
  );
  const purpose = describeDriftDetailed(
    before,
    ROW("a.mjs", "2026-08-01", "A revised."),
  );
  assert.equal(purpose.structural, true);
  assert.equal(
    catalogCheckExitCode(before, ROW("a.mjs", "2026-08-01", "A revised.")),
    1,
  );
  const both = describeDriftDetailed(
    before,
    ROW("a.mjs", "2026-08-16", "A revised."),
  );
  assert.equal(both.structural, true);
  // An identical region is not drift, but a change OUTSIDE the row tables is
  // (prose/layout) - the detailed verdict must call that structural too.
  assert.equal(describeDriftDetailed(before, before).structural, false);
  assert.equal(catalogCheckExitCode(before, before), 0);
});

test("D5: duplicate basenames retain directory-qualified drift identities", () => {
  const before = [
    "### Tools/a/ (1)",
    ROW("same.mjs", "2026-08-01", "A."),
    "### Tools/b/ (1)",
    ROW("same.mjs", "2026-08-01", "B."),
  ].join("\n");
  const after = [
    "### Tools/a/ (1)",
    ROW("same.mjs", "2026-08-01", "A."),
    "### Tools/b/ (1)",
    ROW("same.mjs", "2026-08-01", "B revised."),
  ].join("\n");
  const lines = describeDrift(before, after);
  assert.match(lines[0], /added 0, removed 0, changed 1/u);
  assert.ok(lines.some((line) => line.trim() === "~ Tools/b/same.mjs"));
});

test("D6: ambiguous basenames do not create phantom inbound references", () => {
  const files = [
    "Tools/example-a/duplicate-name.mjs",
    "Tools/example-b/duplicate-name.mjs",
  ];
  const byPath = new Set(files);
  const byBase = new Map([["duplicate-name.mjs", files]]);
  assert.equal(
    resolveReferenceToken(
      "migration_doc/a.md",
      "duplicate-name.mjs",
      byPath,
      byBase,
    ),
    null,
  );
  assert.equal(
    resolveReferenceToken(
      "Tools/example-b/probe.mjs",
      "./duplicate-name.mjs",
      byPath,
      byBase,
    ),
    "Tools/example-b/duplicate-name.mjs",
  );
  assert.equal(
    resolveReferenceToken(
      "migration_doc/a.md",
      "Tools/example-a/duplicate-name.mjs",
      byPath,
      byBase,
    ),
    "Tools/example-a/duplicate-name.mjs",
  );
});

test("D7: --check cannot be bypassed by combining it with --stdout", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--check", "--stdout"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /mutually exclusive/u);
});

// --- E: the census refuses what it cannot read, and plans what it can -----

const PLAN_ALLOWLIST =
  "Tools/visual-regression/lib/probe-fleet-contract-allowlist.mjs";

const planRow = (file, status) => ({ file, status });

function planFixture(entries, references = {}) {
  const rows = [
    planRow(PLAN_ALLOWLIST, "ACTIVE"),
    ...entries.map(([file, status]) => planRow(file, status)),
  ];
  const refSources = new Map(
    rows.map((row) => [row.file, new Set(references[row.file] ?? [])]),
  );
  return { rows, refSources };
}

test("E1: a census header the parser cannot read is STRUCTURAL, not a blank row", () => {
  // A header that never closes its comment used to be indistinguishable in the
  // published table from a file that simply has no header: both rendered "NO
  // @purpose HEADER". The census must refuse a subject it cannot read rather
  // than publish a guess about it.
  const sandbox = createCandidateSandbox();
  const fixture = "Tools/tooling-catalog-malformed-header-fixture.mjs";
  const catalogBefore = readFileSync(CATALOG, "utf8");
  try {
    // The launcher executes the CANDIDATE-INDEX blobs, never the worktree, so
    // an unstaged repair is invisible to it. Stage the runtime under test.
    for (const rel of [
      "Tools/generate-tooling-catalog.mjs",
      "Tools/lib/purpose-header.mjs",
    ]) {
      updateCandidatePath(
        sandbox,
        rel,
        readFileSync(path.join(ROOT, ...rel.split("/")), "utf8"),
      );
    }
    const malformed = [
      "/*",
      " * A header block that is never closed.",
      " * @purpose Deliberately malformed fixture for the fail-closed census.",
      " * @status ACTIVE",
      "export const value = 1;",
      "",
    ].join("\n");
    const oid = writeCandidateBlob(sandbox, malformed);
    updateCandidateEntry(sandbox, fixture, "100644", oid);

    const run = runCandidate(sandbox, ["--check"]);
    assert.equal(run.status, 3, run.stderr);
    assert.match(run.stderr, /header block comment is never closed/u);
    assert.match(run.stderr, /malformed-header-fixture/u);
    assert.equal(
      readFileSync(CATALOG, "utf8"),
      catalogBefore,
      "a refused census must not have touched the catalog",
    );
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("E2: the plan states the preconditions a move has to clear", () => {
  const fixture = planFixture(
    [
      ["Tools/visual-regression/probe-clean.mjs", "INVESTIGATION"],
      ["Tools/visual-regression/probe-cited.mjs", "INVESTIGATION"],
      ["Tools/visual-regression/probe-listed.mjs", "ARCHIVED-CANDIDATE"],
      ["Tools/visual-regression/archive/probe-done.mjs", "INVESTIGATION"],
      ["Tools/visual-regression/probe-live.mjs", "ACTIVE"],
    ],
    {
      "Tools/visual-regression/probe-cited.mjs": [
        "migration_doc/DEBUGGING_GUIDE.md",
        "migration_doc/archive/OLD_REPORT.md",
      ],
      "Tools/visual-regression/probe-listed.mjs": [PLAN_ALLOWLIST],
      "Tools/visual-regression/archive/probe-done.mjs": [
        "migration_doc/archive/OLD_REPORT.md",
      ],
    },
  );
  const plan = archivePlanRows(fixture.rows, fixture.refSources);

  assert.deepEqual(
    plan.map((row) => [row.file, row.disposition]),
    [
      ["Tools/visual-regression/archive/probe-done.mjs", "ALREADY-ARCHIVED"],
      ["Tools/visual-regression/probe-cited.mjs", "REPOINT-FIRST"],
      ["Tools/visual-regression/probe-clean.mjs", "MOVE"],
      ["Tools/visual-regression/probe-listed.mjs", "ALLOWLIST-EDIT-THEN-MOVE"],
    ],
    "an ACTIVE file is not a candidate, and every candidate is graded",
  );

  const cited = plan.find((row) => row.file.endsWith("probe-cited.mjs"));
  assert.equal(cited.live, 1);
  assert.equal(cited.archived, 1);
  assert.equal(cited.allowlisted, false);

  const listed = plan.find((row) => row.file.endsWith("probe-listed.mjs"));
  assert.equal(
    listed.live,
    0,
    "an allowlist row is reported as itself, not as a live citation",
  );
  assert.equal(listed.allowlisted, true);
});

test("E3: a census without the allowlist cannot publish a plan", () => {
  // The allowlist membership column is derived from one pinned path. If that
  // path leaves the census the column silently reads 'no' for every row and
  // the plan understates the work, so the plan refuses instead.
  const refSources = new Map([
    ["Tools/visual-regression/probe-clean.mjs", new Set()],
  ]);
  assert.throws(
    () =>
      archivePlanRows(
        [planRow("Tools/visual-regression/probe-clean.mjs", "INVESTIGATION")],
        refSources,
      ),
    /fleet-contract allowlist .* is not in the census/u,
  );
});

test("E4: plan anchors come from the path, never from the row position", () => {
  const forward = planFixture([
    ["Tools/visual-regression/probe-a.mjs", "INVESTIGATION"],
    ["Tools/visual-regression/probe-b.mjs", "INVESTIGATION"],
  ]);
  const reversed = planFixture([
    ["Tools/visual-regression/probe-b.mjs", "INVESTIGATION"],
    ["Tools/visual-regression/probe-a.mjs", "INVESTIGATION"],
  ]);
  const anchorsOf = (fixture) =>
    new Map(
      archivePlanRows(fixture.rows, fixture.refSources).map((row) => [
        row.file,
        row.anchor,
      ]),
    );
  assert.deepEqual([...anchorsOf(forward)], [...anchorsOf(reversed)]);
  assert.equal(
    archivePlanAnchor("Tools/visual-regression/probe-a.mjs"),
    "ap-tools-visual-regression-probe-a-mjs",
  );

  // Two paths that slug to one anchor would give two rows one citation.
  const colliding = planFixture([
    ["Tools/visual-regression/probe-a.mjs", "INVESTIGATION"],
    ["Tools/visual-regression/probe.a.mjs", "INVESTIGATION"],
  ]);
  assert.throws(
    () => archivePlanRows(colliding.rows, colliding.refSources),
    /is claimed by both/u,
  );
});

test("E5: only a parent directory named archive marks a file retired", () => {
  assert.equal(isUnderArchiveDirectory("Tools/archive/old.mjs"), true);
  assert.equal(
    isUnderArchiveDirectory("Tools/visual-regression/archive/old.mjs"),
    true,
  );
  assert.equal(
    isUnderArchiveDirectory("Tools/visual-regression/probe-archive.mjs"),
    false,
    "a file merely NAMED archive has not been retired",
  );
  assert.equal(isUnderArchiveDirectory("Tools/archive.mjs"), false);
});

test("E6: the plan renders inside the generated region", () => {
  // It is derived, not authored. Outside the markers the launcher would never
  // rewrite it and it would go stale exactly like the hand-maintained index
  // that this generator replaced.
  const region = renderCensus(census(), "\n");
  const at = region.indexOf("## Archive plan");
  assert.ok(at > 0, "the plan section is missing from the rendered region");
  assert.ok(at > region.indexOf(BEGIN_MARKER));
  assert.ok(at < region.indexOf(END_MARKER));

  const split = splitCatalog(`# Prose above\n\n${region}\n\nProse below\n`);
  assert.notEqual(split, null);
  assert.ok(split.region.includes("## Archive plan"));
  assert.ok(!split.after.includes("## Archive plan"));
});

test("E7: every census reference is accounted for by exactly one column", () => {
  // live + archived + the allowlist row must reconstruct the census Refs
  // column. If they do not, the plan is quietly dropping or double-counting a
  // citation and its dispositions cannot be trusted.
  const data = census();
  const refsByFile = new Map(data.rows.map((row) => [row.file, row.refs]));
  assert.ok(data.archivePlan.length > 0, "the real tree has no candidates");
  for (const row of data.archivePlan) {
    assert.equal(
      row.live + row.archived + (row.allowlisted ? 1 : 0),
      refsByFile.get(row.file),
      `${row.file} reference accounting disagrees with the census`,
    );
  }
});

test("E9: a census with no archive plan cannot be rendered", () => {
  // Rendering an empty section when the producer forgot the plan would delete
  // it from the document without a single failing gate.
  // eslint-disable-next-line no-unused-vars
  const { archivePlan, ...withoutPlan } = census();
  assert.throws(
    () => renderCensus(withoutPlan, "\n"),
    /carries no archive plan/u,
  );
});

test("E8: reference counts are the sizes of the reference-source sets", () => {
  const files = listToolingFiles();
  const sources = inboundRefSources(files);
  const counts = inboundRefs(files, sources);
  assert.equal(counts.size, files.length);
  for (const file of files) {
    assert.equal(counts.get(file), sources.get(file).size);
    assert.ok(
      !sources.get(file).has(file),
      "a file must not count as its own inbound reference",
    );
  }
});

test("E10: plan order is code-unit, so the table does not depend on ICU", () => {
  // The rendered table is byte-compared by --check. `localeCompare` and
  // code-unit order genuinely disagree on these two paths, so ordering by
  // collation would let a small-ICU or differently-collated Node reorder every
  // row with no source change - reported as structural drift with nothing in
  // the diff to explain it.
  // Synthetic paths: naming two REAL census files here would raise their own
  // inbound-reference counts and move rows in the table this spec certifies.
  const lower = "scripts/archive/dx14-order-fixture.mjs";
  const upper = "Tools/archive/dx14-order-fixture.mjs";
  assert.notEqual(
    Math.sign(lower.localeCompare(upper)),
    lower < upper ? -1 : 1,
    "fixture is void unless the two orders actually disagree on this pair",
  );

  const fixture = planFixture([
    [lower, "INVESTIGATION"],
    [upper, "INVESTIGATION"],
  ]);
  const order = archivePlanRows(fixture.rows, fixture.refSources).map(
    (row) => row.file,
  );
  assert.deepEqual(order, [...order].sort(), "rows must be in code-unit order");
  assert.ok(
    order.indexOf(upper) < order.indexOf(lower),
    "uppercase Tools/ sorts before lowercase scripts/ by code unit",
  );
});
