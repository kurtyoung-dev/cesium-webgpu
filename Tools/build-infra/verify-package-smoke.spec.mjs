// Contract for the packed-package smoke test that CI's node-smoke-test job runs.
//
// That job packs the root package and the workspaces, installs the tarballs into
// a bare sibling directory and runs the ESM smoke test there. The packed engine
// ships TypeScript sources, so the test only gets as far as importing `cesium`
// when two things are true of the packed result: every top-level module the
// `cesium` barrel imports from `@cesium/engine` is inside the engine tarball,
// and the Node hook the test registers (and the esbuild it imports) reaches the
// directory the test runs in. Both were missing at once, so the job failed at
// `register-ts.mjs` first and would have failed at `index-wgsl.js` next.
// @purpose Asserts the packed engine ships its top-level entry modules and the verify-package script stages the TypeScript hook and esbuild beside the ESM smoke test.
// @status ACTIVE

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { laneTmpRoot, mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const PACKAGES = ["engine", "widgets"];

// A candidate can be checked before it is applied: point these at the
// candidate's text and the spec reads it in place of the tracked file.
const SCRIPT_PATH =
  process.env.CESIUM_VERIFY_PACKAGE_SCRIPT ??
  path.join(REPO_ROOT, ".github", "actions", "verify-package", "script.sh");
const ENGINE_PACKAGE_JSON =
  process.env.CESIUM_ENGINE_PACKAGE_JSON ??
  path.join(REPO_ROOT, "packages", "engine", "package.json");

// Every scratch directory lives under one run directory in this lane's temp
// root (Tools/lib/lane-tmp.mjs), so the run leaves nothing behind: the run
// directory is removed after the last test, and the lane root with it when no
// other run is still using it.
let runDir;

function scratchDir(prefix) {
  runDir ??= mkLaneTmp("verify-package-smoke-");
  return mkdtempSync(path.join(runDir, `${prefix}-`));
}

test.after(() => {
  if (runDir === undefined) {
    return;
  }
  removeLaneTmp(runDir);
  try {
    rmdirSync(laneTmpRoot());
  } catch (error) {
    if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") {
      throw error;
    }
  }
});

/**
 * The paths `npm pack` would put in a tarball for a package whose top level is
 * `topLevelDir` and whose manifest is `packageJsonPath`. Only the top level is
 * reproduced (plus one placeholder under `Source/`), which is all the `files`
 * list is asked about here, so the pack stays fast and runs on an unbuilt tree.
 */
function packedPaths(topLevelDir, packageJsonPath) {
  const fixture = scratchDir("pack");
  if (topLevelDir) {
    for (const entry of readdirSync(topLevelDir)) {
      const from = path.join(topLevelDir, entry);
      if (entry !== "package.json" && statSync(from).isFile()) {
        copyFileSync(from, path.join(fixture, entry));
      }
    }
  }
  copyFileSync(packageJsonPath, path.join(fixture, "package.json"));
  mkdirSync(path.join(fixture, "Source"));
  writeFileSync(path.join(fixture, "Source", "placeholder.js"), "");

  const result = spawnSync(
    "npm",
    ["pack", `"${fixture}"`, "--dry-run", "--json", "--ignore-scripts"],
    { encoding: "utf8", shell: true },
  );
  assert.equal(result.status, 0, `npm pack failed: ${result.stderr}`);
  const [pack] = JSON.parse(result.stdout);
  return new Set(pack.files.map((file) => file.path));
}

function packageJsonFor(name) {
  return name === "engine"
    ? ENGINE_PACKAGE_JSON
    : path.join(REPO_ROOT, "packages", name, "package.json");
}

function topLevelEntryModules(name) {
  const dir = path.join(REPO_ROOT, "packages", name);
  return readdirSync(dir).filter(
    (entry) =>
      /^index.*\.js$/.test(entry) && statSync(path.join(dir, entry)).isFile(),
  );
}

test("the tarball detector reports a top-level module the manifest leaves out", () => {
  const dir = scratchDir("detector");
  writeFileSync(path.join(dir, "index.js"), "");
  writeFileSync(path.join(dir, "index-wgsl.js"), "");
  const manifest = path.join(dir, "package.json.candidate");
  writeFileSync(
    manifest,
    JSON.stringify({
      name: "x",
      version: "1.0.0",
      files: ["index.js", "Source"],
    }),
  );
  const packed = packedPaths(dir, manifest);
  assert.ok(packed.has("index.js"));
  assert.ok(!packed.has("index-wgsl.js"));
});

for (const name of PACKAGES) {
  test(`the packed @cesium/${name} contains every top-level index module on disk`, (t) => {
    const entries = topLevelEntryModules(name);
    // index.js is gitignored build output, so an unbuilt tree (CI's guards
    // job) has no top-level module for widgets at all; engine keeps its
    // tracked index-wgsl.js and is still checked there.
    if (entries.length === 0) {
      t.skip(`no index*.js on disk for ${name}: this tree is unbuilt`);
      return;
    }
    const packed = packedPaths(
      path.join(REPO_ROOT, "packages", name),
      packageJsonFor(name),
    );
    const missing = entries.filter((entry) => !packed.has(entry));
    assert.deepEqual(
      missing,
      [],
      `@cesium/${name} would be published without ${missing.join(", ")}`,
    );
  });

  test(`every top-level module the cesium barrel imports from @cesium/${name} is packed`, (t) => {
    const barrel = path.join(REPO_ROOT, "Source", "Cesium.js");
    if (!existsSync(barrel)) {
      t.skip("Source/Cesium.js is build output and this tree is unbuilt");
      return;
    }
    const specifier = new RegExp(`from ['"]@cesium/${name}/([^'"]+)['"]`, "g");
    const wanted = new Set();
    for (const match of readFileSync(barrel, "utf8").matchAll(specifier)) {
      if (!/^(Source|Build)\//.test(match[1])) {
        wanted.add(match[1]);
      }
    }
    const packed = packedPaths(
      path.join(REPO_ROOT, "packages", name),
      packageJsonFor(name),
    );
    const missing = [...wanted].filter((entry) => !packed.has(entry));
    assert.deepEqual(
      missing,
      [],
      `the cesium barrel imports ${missing.join(", ")} from @cesium/${name}, which the tarball lacks`,
    );
  });
}

function findBash() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/Git/bin/bash.exe",
          "C:/Program Files/Git/usr/bin/bash.exe",
        ]
      : ["/bin/bash", "/usr/bin/bash"];
  return candidates.find((candidate) => existsSync(candidate));
}

const STUB_SOURCE = `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [tool, ...args] = process.argv.slice(2);
const cwd = process.cwd();
appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool, args, cwd }) + "\\n");

function refuse(message) {
  process.stderr.write(message + "\\n");
  process.exit(1);
}

if (tool === "node" && args[0] === "-p") {
  const real = spawnSync(process.env.STUB_REAL_NODE, args, { encoding: "utf8" });
  process.stdout.write(real.stdout);
  process.exit(real.status ?? 1);
}

if (tool === "node" && path.basename(args[0] ?? "") === "test.mjs" && path.basename(cwd) === "test") {
  if (!existsSync(path.join(cwd, "register-ts.mjs"))) {
    refuse("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '" + path.join(cwd, "register-ts.mjs") + "' imported from test.mjs");
  }
  if (!existsSync(path.join(cwd, "node_modules", "esbuild", "package.json"))) {
    refuse("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from register-ts.mjs");
  }
}

if (tool === "npm" && args[0] === "install") {
  for (const spec of args.slice(1)) {
    if (spec.endsWith(".tgz")) {
      if (!existsSync(path.join(cwd, spec))) refuse("npm ERR! tarball not found: " + spec);
    } else {
      const name = spec.replace(/(?<=.)@.*$/, "");
      mkdirSync(path.join(cwd, "node_modules", name), { recursive: true });
      writeFileSync(path.join(cwd, "node_modules", name, "package.json"), "{}");
    }
  }
}
`;

function runVerifyPackage(bash) {
  const sandbox = scratchDir("sandbox");
  const repo = path.join(sandbox, "repo");
  const bin = path.join(sandbox, "bin");
  const log = path.join(sandbox, "calls.jsonl");
  mkdirSync(repo);
  mkdirSync(bin);

  copyFileSync(
    path.join(REPO_ROOT, "package.json"),
    path.join(repo, "package.json"),
  );
  mkdirSync(path.join(repo, "Specs"));
  for (const entry of readdirSync(path.join(REPO_ROOT, "Specs"))) {
    if (/^test\..*js$/.test(entry) || entry === "register-ts.mjs") {
      copyFileSync(
        path.join(REPO_ROOT, "Specs", entry),
        path.join(repo, "Specs", entry),
      );
    }
  }
  for (const name of PACKAGES) {
    mkdirSync(path.join(repo, "packages", name, "Specs"), { recursive: true });
    writeFileSync(path.join(repo, "packages", name, "Specs", "test.mjs"), "");
  }
  for (const tarball of [
    "cesium-engine-26.0.0.tgz",
    "cesium-widgets-16.0.0.tgz",
    "cesium-1.145.0.tgz",
  ]) {
    writeFileSync(path.join(repo, tarball), "");
  }

  const script = path.join(sandbox, "script.sh");
  writeFileSync(
    script,
    readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n"),
  );
  const stub = path.join(sandbox, "stub.mjs");
  writeFileSync(stub, STUB_SOURCE);
  const realNode = process.execPath.replace(/\\/g, "/");
  for (const tool of ["node", "npm"]) {
    writeFileSync(
      path.join(bin, tool),
      `#!/bin/bash\nexec "${realNode}" "${stub.replace(/\\/g, "/")}" ${tool} "$@"\n`,
      { mode: 0o755 },
    );
  }

  const pathKey =
    Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
    "PATH";
  const env = {
    ...process.env,
    [pathKey]: `${bin}${path.delimiter}${process.env[pathKey]}`,
    STUB_LOG: log,
    STUB_REAL_NODE: realNode,
  };
  const result = spawnSync(bash, [script.replace(/\\/g, "/")], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { result, calls, sandbox };
}

test("verify-package leaves the ESM smoke test its TypeScript hook and esbuild", (t) => {
  const bash = findBash();
  if (!bash) {
    t.skip("no bash on this machine");
    return;
  }
  const { result, calls, sandbox } = runVerifyPackage(bash);
  assert.equal(
    result.status,
    0,
    `verify-package failed:\n${result.stderr}${result.stdout}`,
  );

  const inTest = (call) => path.basename(call.cwd) === "test";
  const smokeRun = calls.findIndex(
    (call) =>
      call.tool === "node" &&
      path.basename(call.args[0] ?? "") === "test.mjs" &&
      inTest(call),
  );
  assert.ok(
    smokeRun >= 0,
    "the ESM smoke test never ran in the sibling directory",
  );
  assert.ok(
    existsSync(path.join(sandbox, "test", "register-ts.mjs")),
    "register-ts.mjs is not beside test.mjs",
  );

  const rootPackage = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  const esbuildInstall = calls.findIndex(
    (call) =>
      call.tool === "npm" &&
      call.args[0] === "install" &&
      inTest(call) &&
      call.args.includes(`esbuild@${rootPackage.devDependencies.esbuild}`),
  );
  assert.ok(
    esbuildInstall >= 0 && esbuildInstall < smokeRun,
    "esbuild at the repo's own version was not installed before the smoke test ran",
  );
});
