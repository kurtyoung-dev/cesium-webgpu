import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
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
