import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { execFileSync as realExecFileSync } from "node:child_process";
function loadProvisionNodeModulesJunctions() {
  const scriptPath = fileURLToPath(
    new URL("./provision-worker-clone.mjs", import.meta.url),
  );
  const script = fs.readFileSync(scriptPath, "utf8");
  const start = script.indexOf("export function provisionNodeModulesJunctions");
  const end = script.length;
  assert.notEqual(start, -1, "provisioning function export is present");
  assert.notEqual(end, -1, "provisioning function boundary is present");
  const declaration = script.slice(start, end).replace(/^export /u, "");
  return vm.runInNewContext(`${declaration}\nprovisionNodeModulesJunctions;`, {
    fs,
    path,
    process,
    execFileSync() {
      assert.fail("default execFileSync must not be used by this spec");
    },
  });
}
function makeFakeTree() {
  const sourceRepo = path.resolve("fake-source");
  const clonePath = path.resolve("fake-clone");
  const normalize = (candidate) => path.normalize(candidate);
  const directories = new Set(
    [
      sourceRepo,
      path.join(sourceRepo, "node_modules"),
      path.join(sourceRepo, "packages"),
      path.join(sourceRepo, "packages", "foo"),
      path.join(sourceRepo, "packages", "foo", "node_modules"),
      clonePath,
      path.join(clonePath, "node_modules"),
      path.join(clonePath, "packages"),
      path.join(clonePath, "packages", "foo"),
    ].map(normalize),
  );
  const junctionRequests = [];
  const fsOps = {
    existsSync(candidate) {
      return directories.has(normalize(candidate));
    },
    statSync(candidate) {
      if (!directories.has(normalize(candidate))) {
        const error = new Error(`ENOENT: ${candidate}`);
        error.code = "ENOENT";
        throw error;
      }
      return { isDirectory: () => true };
    },
    readdirSync(candidate, options) {
      assert.equal(
        normalize(candidate),
        normalize(path.join(sourceRepo, "packages")),
      );
      assert.equal(options?.withFileTypes, true);
      return [{ name: "foo", isDirectory: () => true }];
    },
    mkdirSync(candidate, options) {
      assert.equal(options?.recursive, true);
      directories.add(normalize(candidate));
    },
    symlinkSync() {
      assert.fail("the Windows junction path must be used");
    },
  };
  const run = (command, args, options) => {
    junctionRequests.push({
      command,
      args: [...args],
      options: { ...options },
    });
    directories.add(normalize(args[3]));
  };
  return { sourceRepo, clonePath, fsOps, run, junctionRequests };
}
const provisionNodeModulesJunctions = loadProvisionNodeModulesJunctions();
const INERTNESS_MUTANT = "remove the workspace mklink request";
test(`kills inertness mutant: ${INERTNESS_MUTANT}`, () => {
  const fixture = makeFakeTree();
  const result = provisionNodeModulesJunctions({
    sourceRepo: fixture.sourceRepo,
    clonePath: fixture.clonePath,
    fs: fixture.fsOps,
    execFileSync: fixture.run,
    platform: "win32",
  });
  assert.deepEqual(fixture.junctionRequests, [
    {
      command: "cmd",
      args: [
        "/c",
        "mklink",
        "/J",
        path.join(fixture.clonePath, "packages", "foo", "node_modules"),
        path.join(fixture.sourceRepo, "packages", "foo", "node_modules"),
      ],
      options: { stdio: "ignore" },
    },
  ]);
  assert.deepEqual(
    [...result.reports],
    ["node_modules already present", "packages/foo/node_modules provisioned"],
  );
  assert.deepEqual([...result.missingWorkspaceNodeModules], []);
});
test("--verify-only exposes workspace node_modules gaps to readiness", () => {
  const fixture = makeFakeTree();
  const result = provisionNodeModulesJunctions({
    sourceRepo: fixture.sourceRepo,
    clonePath: fixture.clonePath,
    verifyOnly: true,
    fs: fixture.fsOps,
    execFileSync: fixture.run,
    platform: "win32",
  });
  assert.deepEqual(fixture.junctionRequests, []);
  assert.deepEqual([...result.reports], ["packages/foo/node_modules missing"]);
  assert.deepEqual(
    [...result.missingWorkspaceNodeModules],
    ["packages/foo/node_modules"],
  );
});

// --- real-filesystem regression: bare `@scope/*` specifiers must resolve
// into the CLONE, not back into the source repo it was cloned from ---------
//
// A worker clone's fresh node_modules used to be ONE junction straight at
// the source repo's node_modules. That is correct for ordinary third-party
// dependencies but wrong for npm workspace members: npm installs those as
// symlinks INSIDE the source repo's own node_modules, pointing at the
// SOURCE repo's own packages/<name> — so the wholesale junction made every
// `@cesium/engine` / `@cesium/widgets` import resolve back into the seat
// repo, and every clone-local build/tsc/spec run compiled against unmerged
// seat source (the mechanism behind lane S's merge-lane build failure).
//
// This builds a small but REAL seat-shaped tree under os.tmpdir() — no
// mocked fs — with a genuine npm-style workspace junction
// (node_modules/@scope/pkg -> ../../packages/pkg) on the "source" side, then
// runs the real exported provisioner against it with the real fs and the
// real execFileSync (so it actually calls `mklink /J` on this platform).
function assertUnderTmpdir(candidate) {
  const resolvedCandidate = path.resolve(candidate).toLowerCase();
  const resolvedTmp = path.resolve(os.tmpdir()).toLowerCase();
  assert.ok(
    resolvedCandidate === resolvedTmp ||
      resolvedCandidate.startsWith(resolvedTmp + path.sep.toLowerCase()),
    `fixture root must live under os.tmpdir() (got ${candidate})`,
  );
}

function makeRealWorkspaceTempTree() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "provision-workspace-redirect-"),
  );
  assertUnderTmpdir(root);
  const sourceRepo = path.join(root, "source-repo");
  const clonePath = path.join(root, "clone-repo");

  // Source side: a seat-shaped tree — one workspace package (@scope/engine)
  // whose node_modules entry is a genuine npm-style junction back into the
  // SOURCE repo's own packages/, plus one ordinary third-party dependency
  // (left-pad) and one non-workspace scoped package (@scope/eslint-config)
  // sharing the same @scope directory as the workspace member — mirroring
  // this repo's real node_modules/@cesium/{engine,eslint-config} layout.
  fs.mkdirSync(path.join(sourceRepo, "packages", "engine"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(sourceRepo, "packages", "engine", "package.json"),
    JSON.stringify({ name: "@scope/engine" }),
  );
  fs.mkdirSync(path.join(sourceRepo, "node_modules", "@scope"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(sourceRepo, "node_modules", "left-pad"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(sourceRepo, "node_modules", "left-pad", "index.js"),
    "module.exports = 1;\n",
  );
  fs.mkdirSync(
    path.join(sourceRepo, "node_modules", "@scope", "eslint-config"),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(
      sourceRepo,
      "node_modules",
      "@scope",
      "eslint-config",
      "index.js",
    ),
    "module.exports = {};\n",
  );
  fs.symlinkSync(
    path.join(sourceRepo, "packages", "engine"),
    path.join(sourceRepo, "node_modules", "@scope", "engine"),
    "junction",
  );

  // Clone side: the same workspace member, but as the clone's OWN tracked
  // copy (a real `git clone` gives every worker its own packages/engine —
  // it is never shared with the source repo).
  fs.mkdirSync(path.join(clonePath, "packages", "engine"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(clonePath, "packages", "engine", "package.json"),
    JSON.stringify({ name: "@scope/engine" }),
  );
  fs.writeFileSync(
    path.join(clonePath, "packages", "engine", "index.js"),
    "module.exports = 'clone';\n",
  );

  return { root, sourceRepo, clonePath };
}

const REAL_FS_INERTNESS_MUTANT =
  "the workspace-map lookup is replaced with an empty Map (redirect never fires)";
test(`real fs: @scope workspace member resolves into the clone, not the source repo [kills inertness mutant: ${REAL_FS_INERTNESS_MUTANT}]`, () => {
  const { root, sourceRepo, clonePath } = makeRealWorkspaceTempTree();
  try {
    const result = provisionNodeModulesJunctions({
      sourceRepo,
      clonePath,
      fs,
      execFileSync: realExecFileSync,
      platform: "win32",
    });
    assert.deepEqual([...result.missingWorkspaceNodeModules], []);

    // The observable behaviour a real worker's build/tsc/spec run depends
    // on: resolving the bare specifier's directory must land inside the
    // CLONE, never back on the source repo it was cloned from. realpathSync
    // follows the junction exactly the way Node's module resolver does when
    // it resolves `require.resolve('@scope/engine')`.
    const resolvedEngineDir = fs.realpathSync(
      path.join(clonePath, "node_modules", "@scope", "engine"),
    );
    assert.equal(
      path.resolve(resolvedEngineDir).toLowerCase(),
      path.resolve(clonePath, "packages", "engine").toLowerCase(),
      "the @scope/engine specifier must resolve into the CLONE's own packages/engine",
    );
    assert.notEqual(
      path.resolve(resolvedEngineDir).toLowerCase(),
      path.resolve(sourceRepo, "packages", "engine").toLowerCase(),
      "the @scope/engine specifier must NOT resolve back into the source repo",
    );

    // A non-workspace member of the SAME scope is untouched: still linked
    // from the source repo (it is a real dependency, not clone-owned
    // source).
    const resolvedEslintConfig = fs.realpathSync(
      path.join(clonePath, "node_modules", "@scope", "eslint-config"),
    );
    assert.equal(
      path.resolve(resolvedEslintConfig).toLowerCase(),
      path
        .resolve(sourceRepo, "node_modules", "@scope", "eslint-config")
        .toLowerCase(),
    );

    // An ordinary unscoped dependency is still linked wholesale from the
    // source repo (same filesystem, no copy) — the fix must not touch
    // anything outside the workspace scopes.
    const resolvedLeftPad = fs.realpathSync(
      path.join(clonePath, "node_modules", "left-pad"),
    );
    assert.equal(
      path.resolve(resolvedLeftPad).toLowerCase(),
      path.resolve(sourceRepo, "node_modules", "left-pad").toLowerCase(),
    );
  } finally {
    assertUnderTmpdir(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
