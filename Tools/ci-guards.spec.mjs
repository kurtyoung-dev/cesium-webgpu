// Contract for the CI job that runs this repo's build-free guard scripts.
//
// The guards themselves were green for months while nothing in CI ran them, so
// a break only surfaced when somebody happened to run one by hand. Wiring them
// into a workflow fixes that, but only for as long as the wiring stays intact:
// a job left in place with its command list trimmed looks exactly like a
// working job in the Actions UI. These assertions read the workflow and fail
// when the wiring goes inert.
//
// The guards job runs `test-build-infra`, which runs this file, so the job
// verifies its own contents.
// @purpose Asserts the CI guards job wires every build-free guard, stays build-free, and records why the excluded guards are excluded.
// @status ACTIVE

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "dev.yml");

/**
 * Every guard the job must run, in no particular order.
 *
 * Each was measured green in an unbuilt tree, which is why the job needs no
 * build step. Adding a guard here without adding it to the workflow fails the
 * wiring test below, and vice versa.
 *
 * @type {string[]}
 */
const WIRED_GUARDS = [
  "npm run lint-comment-markers",
  "npm run lint-debug-pragmas",
  "npm run test-c16",
  "npm run test-landing-rules",
  "npm run test-build-infra",
  "npm run test-webgpu-policy",
  "npm run audit-feature-renderers",
  "npm run collection-sentinels-check",
  "npm run verify-tracked-references",
];

/**
 * Guards that must NOT be wired, each for a reason recorded in the workflow.
 *
 * @type {string[]}
 */
const EXCLUDED_GUARDS = [
  "verify-tooling-catalog",
  "test-tooling-catalog",
  "verify-landing",
];

/**
 * Tools reached only through a package.json script, which therefore have no
 * other reference keeping them alive.
 *
 * @type {string[]}
 */
const SCRIPT_ONLY_TOOLS = [
  "Tools/verify-tracked-references.mjs",
  "Tools/audit-feature-renderers.mjs",
  "Tools/collection-sentinels-check.mjs",
];

const workflowText = readFileSync(WORKFLOW_PATH, { encoding: "utf8" });
const workflow = parse(workflowText);
const packageJson = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "package.json"), { encoding: "utf8" }),
);

/**
 * The `run:` strings of the guards job, in file order.
 *
 * @returns {string[]} Commands the job executes.
 */
function guardRunSteps() {
  return (workflow.jobs.guards.steps ?? [])
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run.trim());
}

/**
 * The raw text of the guards job plus the comment block introducing it.
 *
 * Comments are not part of the parsed document, so the rationale assertions
 * have to read the file.
 *
 * @returns {string} The workflow region owning the guards job.
 */
function guardsRegionText() {
  const normalized = workflowText.split("\r\n").join("\n");
  const lines = normalized.split("\n");
  const jobIndex = lines.findIndex((line) => line === "  guards:");
  assert.notEqual(jobIndex, -1, "the guards job header is missing");

  let start = jobIndex;
  while (start > 0 && lines[start - 1].trimStart().startsWith("#")) {
    start -= 1;
  }

  let end = jobIndex + 1;
  while (end < lines.length && !/^ {2}[A-Za-z][\w-]*:$/.test(lines[end])) {
    end += 1;
  }

  return lines.slice(start, end).join("\n");
}

test("the workflow declares a guards job on the standard runner", () => {
  assert.ok(workflow.jobs, "dev.yml has no jobs");
  assert.ok(
    workflow.jobs.guards,
    "dev.yml has no guards job; the guard scripts would run nowhere in CI",
  );
  assert.equal(workflow.jobs.guards["runs-on"], "ubuntu-latest");
});

test("every build-free guard is wired, and none has been dropped", () => {
  const runs = guardRunSteps();
  const missing = WIRED_GUARDS.filter((guard) => !runs.includes(guard));
  assert.deepEqual(
    missing,
    [],
    `the guards job no longer runs: ${missing.join(", ")}. A job whose command list was trimmed still reports green in the Actions UI, which is the failure this asserts against.`,
  );

  const guardRuns = runs.filter((run) => run !== "npm install");
  assert.equal(
    guardRuns.length,
    WIRED_GUARDS.length,
    `the guards job runs ${guardRuns.length} guard commands but ${WIRED_GUARDS.length} are expected: ${guardRuns.join(" | ")}`,
  );
});

test("every wired npm script actually exists", () => {
  for (const guard of WIRED_GUARDS) {
    const scriptName = guard.replace(/^npm run /, "");
    assert.ok(
      Object.hasOwn(packageJson.scripts, scriptName),
      `the guards job runs "${guard}" but package.json has no "${scriptName}" script`,
    );
  }
});

test("the tools reached only through a script are present", () => {
  for (const tool of SCRIPT_ONLY_TOOLS) {
    const script = Object.values(packageJson.scripts).find((value) =>
      value.includes(tool),
    );
    assert.ok(script, `no package.json script launches ${tool}`);
    assert.doesNotThrow(
      () => readFileSync(path.join(REPO_ROOT, tool)),
      `${tool} is referenced by a script but missing from the tree`,
    );
  }
});

test("the guards job stays build-free", () => {
  // Load-bearing, not cosmetic: the job's value is that it reports in a minute
  // instead of waiting on the engine build, and every guard was measured green
  // in an unbuilt tree. A build step creeping in would also mask a guard that
  // had quietly grown a build dependency.
  const offenders = guardRunSteps().filter((run) =>
    /npm run build|gulp build|build-release|buildAllVariants/.test(run),
  );
  assert.deepEqual(
    offenders,
    [],
    `the guards job must not build; found: ${offenders.join(" | ")}`,
  );
});

test("the excluded guards are not wired", () => {
  const runs = guardRunSteps().join("\n");
  for (const excluded of EXCLUDED_GUARDS) {
    assert.ok(
      !runs.includes(excluded),
      `${excluded} is wired into the guards job but is known to fail on a hosted runner`,
    );
  }
});

test("tie: the workflow records why each excluded guard is excluded", () => {
  // Deliberately a source-text assertion. An exclusion with no stated reason
  // decays into an unexplained gap that the next reader either restores blindly
  // or leaves forever.
  const region = guardsRegionText();
  for (const excluded of EXCLUDED_GUARDS) {
    assert.ok(
      region.includes(excluded),
      `the guards job does not say why ${excluded} is excluded`,
    );
  }
  assert.match(
    region,
    /fetch-depth/,
    "the verify-landing exclusion rests on the checkout depth; that reasoning must be written down",
  );
});
