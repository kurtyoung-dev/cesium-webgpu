// Type-checks the engine TypeScript project, but only in a tree that has been
// built.
//
// The engine sources import shader modules that the build generates from the
// .glsl/.wgsl originals (`packages/engine/.gitignore` excludes
// `Source/Shaders/**/*.js`). In a fresh clone those files do not exist, so
// `tsc -p packages/engine/tsconfig.json` reports a wall of TS2307 "cannot find
// module" errors that say nothing about the change being committed. Running it
// unconditionally from a git hook would therefore block every commit made
// before the first build.
//
// The compromise is a sentinel: run the real check when the generated modules
// are present, and say out loud when they are not. The message is not
// decoration — a silent skip is indistinguishable from a passing check, which
// is the failure mode this script exists to remove.
// @purpose Runs the engine project type check when the tree is built, and prints an explicit skip line when it is not.
// @status ACTIVE

import { existsSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The last file the build's WGSL step writes.
 *
 * `wgslToJavaScript` in `scripts/build.js` emits this index after awaiting
 * every per-shader module, and `glslToJavaScript` runs before it, so the file
 * existing implies both shader-generation passes ran to completion. Picking a
 * single generated shader instead would be satisfied by a half-finished build.
 *
 * @type {string}
 */
export const ENGINE_BUILD_SENTINEL =
  "packages/engine/Source/Shaders/WebGPU/chunks/CsmBuiltins.js";

/** @type {string} */
export const ENGINE_TSCONFIG = "packages/engine/tsconfig.json";

/** @type {string} */
export const SKIP_MESSAGE =
  "engine type check skipped: tree not built — CI covers it";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * @typedef {object} EngineTypeCheckPlan
 * @property {"run"|"skip"} action What the caller should do.
 * @property {string} sentinel Absolute path that was probed.
 * @property {string} [message] Printed verbatim when the action is "skip".
 * @property {string} [command] Executable to spawn when the action is "run".
 * @property {string[]} [args] Arguments for that executable.
 */

/**
 * Decides whether the engine project can be type-checked in this tree.
 *
 * Pure: the filesystem probe is injected so the decision is testable without a
 * build and without spawning a compiler.
 *
 * @param {object} [options] Options.
 * @param {string} [options.root] Repository root.
 * @param {(absolutePath: string) => boolean} [options.exists] Existence probe.
 * @returns {EngineTypeCheckPlan} The decision.
 */
export function planEngineTypeCheck(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const exists = options.exists ?? existsSync;
  const sentinel = path.join(root, ENGINE_BUILD_SENTINEL);

  if (!exists(sentinel)) {
    return { action: "skip", sentinel, message: SKIP_MESSAGE };
  }

  return {
    action: "run",
    sentinel,
    command: "npx",
    args: ["tsc", "--noEmit", "-p", ENGINE_TSCONFIG],
  };
}

/**
 * Carries out a plan and resolves to the exit code the caller should adopt.
 *
 * @param {object} [options] Options.
 * @param {EngineTypeCheckPlan} [options.plan] Plan to execute; computed if absent.
 * @param {Function} [options.spawn] Child-process spawner.
 * @param {(message: string) => void} [options.log] Skip-message sink.
 * @param {string} [options.cwd] Working directory for the child.
 * @returns {Promise<number>} The exit code.
 */
export function runEngineTypeCheck(options = {}) {
  const cwd = options.cwd ?? REPO_ROOT;
  const spawn = options.spawn ?? nodeSpawn;
  const log = options.log ?? console.log;
  const plan = options.plan ?? planEngineTypeCheck({ root: cwd });

  if (plan.action === "skip") {
    log(plan.message);
    return Promise.resolve(0);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd,
      stdio: "inherit",
      // `npx` resolves through a .cmd shim on Windows, which cannot be
      // executed without a shell.
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // A signalled child reports a null code; letting that coerce to 0 would
      // turn a killed compiler into a passing gate.
      resolve(code === null ? (signal ? 1 : 0) : code);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runEngineTypeCheck()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`engine type check: ${error.message}`);
      process.exitCode = 1;
    });
}
