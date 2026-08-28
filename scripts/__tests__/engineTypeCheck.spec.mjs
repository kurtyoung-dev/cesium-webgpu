// Contract for the conditional engine type check the pre-commit hook runs.
//
// Two classes of assertion live here and they are not interchangeable. The
// behavioural tests drive the real exported functions with an injected
// filesystem probe and an injected spawner, so they fail when the decision or
// the exit-code plumbing is wrong. The two tie tests read source text on
// purpose: they exist to catch drift that would leave every behavioural test
// green while the gate quietly stopped running — a renamed build artifact, or
// a hook that dropped the step.
// @purpose Proves the engine type check runs only in a built tree, propagates failure, announces every skip, and stays tied to the build artifact and the hook.
// @status ACTIVE

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENGINE_BUILD_SENTINEL,
  ENGINE_TSCONFIG,
  SKIP_MESSAGE,
  planEngineTypeCheck,
  runEngineTypeCheck,
} from "../engineTypeCheck.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const FAKE_ROOT = path.join(path.sep, "fake-root");
const FAKE_SENTINEL = path.join(FAKE_ROOT, ENGINE_BUILD_SENTINEL);

/**
 * A spawn stub that records its call and closes with a fixed code.
 *
 * @param {number|null} code Exit code to report.
 * @param {string|null} [signal] Signal to report alongside a null code.
 * @returns {{spawn: Function, calls: object[]}} Stub and its call log.
 */
function stubSpawn(code, signal = null) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    setImmediate(() => child.emit("close", code, signal));
    return child;
  };
  return { spawn, calls };
}

test("a built tree plans the engine project check", () => {
  const plan = planEngineTypeCheck({
    root: FAKE_ROOT,
    exists: (candidate) => candidate === FAKE_SENTINEL,
  });

  assert.equal(plan.action, "run");
  assert.equal(plan.sentinel, FAKE_SENTINEL);
  assert.equal(plan.command, "npx");
  assert.deepEqual(plan.args, ["tsc", "--noEmit", "-p", ENGINE_TSCONFIG]);
  assert.notEqual(
    ENGINE_TSCONFIG,
    "tsconfig.json",
    "the plan must target the engine project, not the root project whose include list is scripts/*.js",
  );
});

test("an unbuilt tree skips and carries the message to print", () => {
  const plan = planEngineTypeCheck({ root: FAKE_ROOT, exists: () => false });

  assert.equal(plan.action, "skip");
  assert.equal(plan.message, SKIP_MESSAGE);
  assert.match(
    plan.message,
    /not built/,
    "the skip message must say why it skipped",
  );
});

test("the decision keys on the sentinel, not on any file existing", () => {
  // Everything on disk except the sentinel. A check that degenerated into
  // "some file is present" would run here and fail the commit in a tree that
  // has no generated shaders.
  const plan = planEngineTypeCheck({
    root: FAKE_ROOT,
    exists: (candidate) => candidate !== FAKE_SENTINEL,
  });

  assert.equal(plan.action, "skip");
});

test("a failing compiler propagates its exit code", async () => {
  const { spawn, calls } = stubSpawn(2);
  const code = await runEngineTypeCheck({
    plan: planEngineTypeCheck({ root: FAKE_ROOT, exists: () => true }),
    spawn,
    log: () => {
      assert.fail("the run path must not print the skip message");
    },
  });

  assert.equal(code, 2, "a non-zero compiler status must reach the caller");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "npx");
  assert.equal(calls[0].options.stdio, "inherit");
});

test("a clean compiler run reports success", async () => {
  const { spawn } = stubSpawn(0);
  const code = await runEngineTypeCheck({
    plan: planEngineTypeCheck({ root: FAKE_ROOT, exists: () => true }),
    spawn,
  });

  assert.equal(code, 0);
});

test("a killed compiler is a failure, not a pass", async () => {
  const { spawn } = stubSpawn(null, "SIGKILL");
  const code = await runEngineTypeCheck({
    plan: planEngineTypeCheck({ root: FAKE_ROOT, exists: () => true }),
    spawn,
  });

  assert.notEqual(
    code,
    0,
    "a signalled child reports a null code; that must not read as success",
  );
});

test("the skip path prints the message exactly once and exits clean", async () => {
  const logged = [];
  const code = await runEngineTypeCheck({
    plan: planEngineTypeCheck({ root: FAKE_ROOT, exists: () => false }),
    spawn: () => {
      assert.fail("the skip path must not spawn a compiler");
    },
    log: (message) => logged.push(message),
  });

  assert.equal(code, 0);
  assert.deepEqual(
    logged,
    [SKIP_MESSAGE],
    "a silent skip is indistinguishable from a passing check",
  );
});

test("tie: the sentinel is the file the build's WGSL step writes last", () => {
  // Drift guard, deliberately reading source text. If the generated index is
  // renamed or relocated, the sentinel stops existing in every built tree and
  // the hook skips forever — silently passing while checking nothing. This
  // fails instead.
  const build = readFileSync(path.join(REPO_ROOT, "scripts", "build.js"), {
    encoding: "utf8",
  });

  assert.match(
    build,
    /writeFile\(\s*path\.join\(chunksDir,\s*"CsmBuiltins\.js"\)/,
    "scripts/build.js no longer writes CsmBuiltins.js into the chunks directory",
  );
  assert.match(
    build,
    /const chunksDir = path\.join\([\s\S]*?"Shaders",\s*\n\s*"WebGPU",\s*\n\s*"chunks",/,
    "the chunks directory the build writes into has moved",
  );
  assert.equal(
    ENGINE_BUILD_SENTINEL,
    "packages/engine/Source/Shaders/WebGPU/chunks/CsmBuiltins.js",
    "the sentinel constant must name the path the build writes",
  );
});

test("tie: the pre-commit hook runs the check and no longer overstates the root one", () => {
  // Every behavioural test above passes whether or not the hook calls this
  // script at all, so the wiring needs its own assertion.
  const hook = readFileSync(path.join(REPO_ROOT, ".husky", "pre-commit"), {
    encoding: "utf8",
  });

  assert.match(
    hook,
    /node scripts\/engineTypeCheck\.mjs/,
    "the hook must invoke the engine type check",
  );
  assert.ok(
    !hook.includes("catches type errors"),
    "the root tsc step's comment claimed to catch type errors it never saw; that claim must not return",
  );
  assert.match(
    hook,
    /lint-staged \|\| exit 1/,
    "a lint-staged failure must abort the commit rather than being masked by a later passing step",
  );
});
