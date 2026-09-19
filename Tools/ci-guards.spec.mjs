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

import {
  findOverrideViolations,
  OVERRIDE_RULE,
  parseOverrideKey,
} from "./lib/npm-override-rules.mjs";

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

// ---------------------------------------------------------------------------
// The manifests the job installs from.
//
// Every job of every workflow begins with `npm install`, so an `overrides`
// entry npm refuses is not a lint failure: it is the whole matrix red at step
// one, with no signal about the code. The rule is decided by
// Tools/lib/npm-override-rules.mjs so these cases can drive it with synthetic
// manifests as well as the real ones.
// ---------------------------------------------------------------------------

/**
 * The workspace manifests npm reads alongside the root one.
 *
 * @returns {{path: string, manifest: object}[]} Workspace manifests in declaration order.
 */
function workspaceManifests() {
  return (packageJson.workspaces ?? []).map((relative) => {
    const manifestPath = path.join(REPO_ROOT, relative, "package.json");
    return {
      path: `${relative}/package.json`,
      manifest: JSON.parse(readFileSync(manifestPath, { encoding: "utf8" })),
    };
  });
}

test("the root overrides are installable: npm accepts every entry", () => {
  const workspaces = workspaceManifests();
  assert.equal(
    workspaces.length,
    (packageJson.workspaces ?? []).length,
    "every declared workspace manifest must reach the rule, or this case silently checks the root alone",
  );
  const findings = findOverrideViolations({
    root: packageJson,
    workspaces,
  });
  assert.deepEqual(
    findings.map((finding) => finding.message),
    [],
    "npm loads overrides before it fetches anything, so an entry it refuses fails every job at its first step",
  );
});

test("eslint stays pinned by an exact spec and a reference override", () => {
  // The pin is the point: a floating minor turns a rule's new findings into a
  // red lint gate on a tree nobody changed. `$eslint` is the only override form
  // npm accepts over a direct dependency without repeating its spec.
  assert.match(
    packageJson.devDependencies.eslint,
    /^\d+\.\d+\.\d+$/,
    "the eslint devDependency must be an exact version or the override pins nothing",
  );
  assert.equal(packageJson.overrides.eslint, "$eslint");
});

test("the override shape that breaks npm install is reported, naming the package", () => {
  const findings = findOverrideViolations({
    root: {
      devDependencies: { eslint: "^10.9.1" },
      overrides: { eslint: "10.10.0" },
    },
  });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, OVERRIDE_RULE.ROOT_DIRECT_CONFLICT);
  assert.equal(findings[0].name, "eslint");
  assert.equal(findings[0].npmEnforced, true);
  assert.deepEqual(findings[0].declaredIn, [
    { manifest: "package.json", section: "devDependencies", spec: "^10.9.1" },
  ]);
});

test("the two shapes npm accepts over a direct dependency are not reported", () => {
  assert.deepEqual(
    findOverrideViolations({
      root: {
        devDependencies: { eslint: "10.10.0" },
        overrides: { eslint: "$eslint" },
      },
    }),
    [],
    "a resolvable $reference is the form npm documents for this collision",
  );
  assert.deepEqual(
    findOverrideViolations({
      root: {
        dependencies: { protobufjs: "^8.8.0" },
        overrides: { protobufjs: "^8.8.0" },
      },
    }),
    [],
    "an override byte-identical to the declared spec is accepted",
  );
});

test("a nested override of a transitive dependency is a different, legal shape", () => {
  assert.deepEqual(
    findOverrideViolations({
      root: {
        dependencies: { allotment: "^1.20.4", react: "^19.2.8" },
        overrides: {
          allotment: { "use-resize-observer": { react: "^19.0.0" } },
        },
      },
    }),
    [],
    "the key scopes allotment's children and sets no spec for allotment itself, so it never meets a root edge",
  );
});

test("a $reference to a package the root does not depend on is reported", () => {
  const findings = findOverrideViolations({
    root: {
      devDependencies: { eslint: "10.10.0" },
      overrides: { ms: "$nope" },
    },
  });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, OVERRIDE_RULE.DANGLING_REFERENCE);
  assert.equal(findings[0].npmEnforced, true);
});

test("retargeting a workspace's direct dependency is reported as drift npm allows", () => {
  const findings = findOverrideViolations({
    root: { overrides: { dompurify: "3.4.14" } },
    workspaces: [
      {
        path: "packages/engine/package.json",
        manifest: { dependencies: { dompurify: "^3.4.14" } },
      },
    ],
  });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, OVERRIDE_RULE.WORKSPACE_DIRECT_DRIFT);
  assert.equal(
    findings[0].npmEnforced,
    false,
    "npm asserts root edges only, so this one installs silently",
  );
});

// Every case below states the exit code and first error line npm produced for
// that manifest in a throw-away project holding nothing else. The npm is
// 10.9.8 - the one `actions/setup-node` installs for node-version '22', which
// is what CI runs, and not the 11.4.1 that shadows it on a developer PATH.
// The two majors differ exactly here: 11.4.1 adds a local-package fallback for
// `$name` references that 10.9.8 does not have.

test("a $reference that resolves to another package's spec is the shape npm rejects", () => {
  // npm substitutes the reference and then compares, so `$name` exempts
  // nothing by itself. Measured: exit 1, `Override for debug@^4.4.3 conflicts
  // with direct dependency`.
  const findings = findOverrideViolations({
    root: {
      devDependencies: { ms: "2.1.3", debug: "^4.4.3" },
      overrides: { debug: "$ms" },
    },
  });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, OVERRIDE_RULE.ROOT_DIRECT_CONFLICT);
  assert.equal(findings[0].name, "debug");
  assert.equal(findings[0].npmEnforced, true);
  assert.match(findings[0].message, /resolves to "2\.1\.3"/);
});

test("a $reference resolves from any section the root declares, not devDependencies alone", () => {
  // The follow-up the ledger recommends for `protobufjs` has this shape - the
  // name is a production dependency - and a lookup that only read
  // devDependencies would report it as dangling. Measured: exit 0.
  assert.deepEqual(
    findOverrideViolations({
      root: {
        dependencies: { ms: "2.1.3" },
        devDependencies: { debug: "^4.4.3" },
        overrides: { ms: "$ms" },
      },
    }),
    [],
  );
});

test("the overrides npm ignores outright are not reported", () => {
  // `Edge.spec` skips an override whose value is exactly "*", and
  // `OverrideSet` rewrites an empty value to "*" before that. Measured: both
  // exit 0, `add ms 2.1.3`. Reporting either would redden the guards job on a
  // manifest that installs.
  assert.deepEqual(
    findOverrideViolations({
      root: { devDependencies: { ms: "^2.1.3" }, overrides: { ms: "*" } },
    }),
    [],
  );
  assert.deepEqual(
    findOverrideViolations({
      root: { devDependencies: { ms: "^2.1.3" }, overrides: { ms: "" } },
    }),
    [],
  );
});

test("a selector that is the declared range is a certain EOVERRIDE", () => {
  // A selector does not soften the rule when it cannot miss. Measured: exit 1,
  // `Override for ms@^2.1.3 conflicts with direct dependency`. A caller
  // filtering on npmEnforced to mean "this breaks the install" must see it.
  const findings = findOverrideViolations({
    root: {
      devDependencies: { ms: "^2.1.3" },
      overrides: { "ms@^2.1.3": "2.1.3" },
    },
  });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, OVERRIDE_RULE.SELECTOR_CONDITIONAL);
  assert.equal(findings[0].name, "ms");
  assert.equal(findings[0].npmEnforced, true);
});

test("a selector that may miss the declared range is reported without claiming npm rejects it", () => {
  // Same rule id, opposite npm verdict: measured exit 0, `add ms 2.1.3`,
  // because `^1.0.0` never intersects `^2.1.3`. Flagging this one
  // npmEnforced would be the false alarm the flag exists to prevent, and
  // deciding it properly needs a semver dependency this repo does not have.
  const findings = findOverrideViolations({
    root: {
      devDependencies: { ms: "^2.1.3" },
      overrides: { "ms@^1.0.0": "1.0.0" },
    },
  });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, OVERRIDE_RULE.SELECTOR_CONDITIONAL);
  assert.equal(findings[0].npmEnforced, false);
  assert.match(findings[0].message, /intersects/);
});

test("a version selector in the key sets the package's own spec", () => {
  // `OverrideSet` falls back to the key's selector when the value has no "."
  // key, so this entry pins ms at 2.1.3 rather than only scoping its children.
  // Measured: exit 1, `Override for ms@^2.1.3 conflicts with direct
  // dependency`. Reading the value as "no spec at all" is what hides it.
  const findings = findOverrideViolations({
    root: {
      devDependencies: { ms: "^2.1.3" },
      overrides: { "ms@2.1.3": { debug: "4.4.3" } },
    },
  });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, OVERRIDE_RULE.SELECTOR_CONDITIONAL);
  assert.equal(findings[0].spec, "2.1.3");
  assert.match(findings[0].message, /the spec "2\.1\.3"/);
});

test("a pin written into the key is not workspace drift", () => {
  // This is the shape of the repo's own "@huggingface/transformers@4.2.0"
  // entry, and it does pin: measured, a workspace declaring `debug: "^4.0.0"`
  // under a root `overrides: {"debug@4.3.4": {ms: "2.1.3"}}` resolves debug
  // 4.3.4 where the same tree without the entry resolves 4.4.3 - both exit 0.
  // npm allows it and the version is stated in the key, where it is read, so
  // there is no second statement of it to disagree with.
  assert.deepEqual(
    findOverrideViolations({
      root: { overrides: { "debug@4.3.4": { ms: "2.1.3" } } },
      workspaces: [
        {
          path: "packages/sandcastle/package.json",
          manifest: { dependencies: { debug: "^4.0.0" } },
        },
      ],
    }),
    [],
  );
});

test("the declaration that counts is the last section npm loads", () => {
  // `Node[_loadDeps]` loads peer, prod, optional then dev and keeps the newest
  // edge, so a name in two sections is compared against the later one alone.
  // Measured: this manifest exits 1 with `Override for ms@^2.1.3 conflicts
  // with direct dependency`, and the same one with the sections swapped
  // exits 0.
  const findings = findOverrideViolations({
    root: {
      dependencies: { ms: "2.1.3" },
      devDependencies: { ms: "^2.1.3" },
      overrides: { ms: "2.1.3" },
    },
  });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, OVERRIDE_RULE.ROOT_DIRECT_CONFLICT);
  assert.deepEqual(findings[0].declaredIn, [
    { manifest: "package.json", section: "devDependencies", spec: "^2.1.3" },
  ]);
  assert.deepEqual(
    findOverrideViolations({
      root: {
        dependencies: { ms: "^2.1.3" },
        devDependencies: { ms: "2.1.3" },
        overrides: { ms: "2.1.3" },
      },
    }),
    [],
  );
});

test("an override over a root peerDependency is reported", () => {
  // Root peer edges sit in `edgesOut` like any other, and `assertRootOverrides`
  // walks all of them. Measured: exit 1, `Override for ms@^2.1.3 conflicts
  // with direct dependency`.
  const findings = findOverrideViolations({
    root: {
      peerDependencies: { ms: "^2.1.3" },
      overrides: { ms: "2.1.3" },
    },
  });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].rule, OVERRIDE_RULE.ROOT_DIRECT_CONFLICT);
  assert.equal(findings[0].declaredIn[0].section, "peerDependencies");
});

test("an override key splits into a package name and a selector", () => {
  // Scoped names keep their leading @, which is the case a naive split on "@"
  // gets wrong, and every selector-dependent rule above rests on this.
  assert.deepEqual(parseOverrideKey("eslint"), {
    name: "eslint",
    selector: null,
  });
  assert.deepEqual(parseOverrideKey("@huggingface/transformers@4.2.0"), {
    name: "@huggingface/transformers",
    selector: "4.2.0",
  });
  assert.deepEqual(parseOverrideKey("@scope/pkg"), {
    name: "@scope/pkg",
    selector: null,
  });
});
