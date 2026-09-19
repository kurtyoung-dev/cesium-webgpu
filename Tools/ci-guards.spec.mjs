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

test("the c16 suite runs its spec files one at a time", () => {
  // One spec in that suite owns the live source tree while it runs.
  // comment-marker-guard.spec.mjs plants fixtures into the real
  // packages/{engine,widgets}/Source on purpose - its own docstring (:92-97)
  // records why: "a fixture in a temp directory would prove nothing about the
  // scope predicate, which is one of the things under test". Its sibling
  // comment-only-diff.spec.mjs enumerates that same tree through an fs.readdir
  // walk (comment-marker-guard.mjs:379-405, not git ls-files) and then reads
  // every path it enumerated, in four separate tests. Run as parallel child
  // processes the fixture is removed between the enumerate and the read, and
  // the reader dies with
  //   ENOENT: no such file or directory, open
  //     '.../packages/engine/Source/Scene/C16GuardFixture.js'
  // about one CI run in five. Reproduced 2 of 3 offline with the planting
  // window widened to 300 ms, and 0 of 10 with this flag. Serializing the files
  // is what makes that single ownership real, for a few seconds of runtime;
  // dropping the flag brings the race back without touching a spec.
  const script = packageJson.scripts["test-c16"];
  assert.ok(script, "package.json has no test-c16 script");
  assert.match(
    script,
    /--test-concurrency=1(?![0-9])/,
    "test-c16 must run its spec files one at a time: one of them plants fixtures in the live source tree that the others walk",
  );
  // Position is load-bearing. Node applies the flag only where it precedes the
  // file list: `node --test a.mjs b.mjs --test-concurrency=1` exits 0, says
  // nothing about the trailing argument, and runs the files in parallel anyway
  // (two files sleeping 2 s each: 2.7 s that way, 4.7 s with the flag in
  // front). A flag that has drifted behind the first path is present and inert,
  // which is the one way this assertion could read green over the live race.
  assert.ok(
    script.indexOf("--test-concurrency=1") < script.indexOf("Tools/c16/"),
    "--test-concurrency=1 must come before the spec paths: node ignores it after the file list and runs the files in parallel again",
  );
});

test("the node-smoke-test matrix reports every Node version in one run", () => {
  // A matrix that fails fast cancels its siblings, and a cancelled leg is not a
  // result: across two consecutive runs of this workflow the 24 leg was
  // cancelled once and the 22 leg the next time, so the two have never both
  // reported. The job exists to measure a packaged install under more than one
  // Node major; while either leg cancels the other, half of that measurement
  // does not exist.
  const job = workflow.jobs["node-smoke-test"];
  assert.ok(job, "dev.yml has no node-smoke-test job");
  const versions = job.strategy?.matrix?.version;
  assert.ok(
    Array.isArray(versions) && versions.length > 1,
    "the node-smoke-test job no longer runs a multi-version matrix",
  );
  assert.equal(
    job.strategy?.["fail-fast"],
    false,
    "the node-smoke-test matrix must not fail fast: one leg cancelling the other hides whatever the cancelled leg was about to report",
  );
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

// ---------------------------------------------------------------------------
// The lifecycle scripts a CONSUMER runs.
//
// npm runs `preinstall`, `install` and `postinstall` from the manifest of a
// package installed as a DEPENDENCY: `@npmcli/arborist` sorts the installed
// tree into queues for exactly those three plus `prepare`, and runs the
// `prepare` queue only for link nodes (`rebuild.js:153-168` in npm 10.9.8, the
// npm CI installs). `prepare` and its `preprepare` / `postprepare` wrappers
// belong to the project itself: `npm install` runs that chain for the current
// directory only when it is called with no arguments
// (`lib/commands/install.js:151-169`), which is what npm-scripts(7) states as
// "Runs on local `npm install` without any arguments".
//
// The published tarball is a different set of files from the working tree, so a
// script under one of the three consumer events may name a path that only
// exists here. Such a script cannot succeed anywhere except in a consumer's
// node_modules, where it fails the install outright:
//
//   npm error path .../test/node_modules/cesium
//   npm error command sh -c node scripts/patchEslintSeatbelt.mjs
//   npm error Error: Cannot find module
//     '.../node_modules/cesium/scripts/patchEslintSeatbelt.mjs'
//
// That is what this root manifest shipped for 76 days, and the only thing that
// noticed was a job that was already red. The rule is decided below as a pure
// function over (manifest, publish filter) so the cases can drive it with
// synthetic manifests as well as the real ones.
// ---------------------------------------------------------------------------

/** Lifecycle events npm runs from the manifest of an installed dependency. */
const CONSUMER_INSTALL_EVENTS = ["preinstall", "install", "postinstall"];

/** Paths npm puts in the tarball whatever the filter says. */
const ALWAYS_PUBLISHED = new Set(["package.json"]);

/** Path-shaped runs inside a script command: two or more segments. */
const PATH_RUN = /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*-]+)+/g;

/**
 * Translate the glob subset these manifests use into a regular-expression body.
 *
 * @param {string} pattern One pattern with its anchors and negation removed.
 * @returns {string|null} The body, or null when the pattern is outside the subset.
 */
function compileGlobBody(pattern) {
  if (/[[\]{}()\\]/.test(pattern)) {
    return null;
  }
  let body = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        body += ".*";
        index += 1;
      } else {
        body += "[^/]*";
      }
    } else if (character === "?") {
      body += "[^/]";
    } else {
      body += character.replace(/[.+^$|]/g, "\\$&");
    }
  }
  return body;
}

/**
 * Parse one `.npmignore` line or one `files` entry.
 *
 * The supported subset is the one these manifests use: blank lines, `#`
 * comments, `!` negation, a leading `/` anchor, a trailing `/` directory, and
 * `*` / `?` / `**` globs. Anything else parses as `unsupported`, so an undecided
 * path gets reported rather than waved through.
 *
 * @param {string} line The raw line.
 * @returns {{kind: string, negated?: boolean, matches?: (relPath: string) => boolean, source?: string}} The parsed entry.
 */
function parsePublishPattern(line) {
  const trimmed = line.replace(/\r$/, "").trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return { kind: "skip" };
  }
  let body = trimmed;
  let negated = false;
  if (body.startsWith("!")) {
    negated = true;
    body = body.slice(1);
  }
  let directoryOnly = false;
  if (body.endsWith("/")) {
    directoryOnly = true;
    body = body.slice(0, -1);
  }
  let anchored = false;
  if (body.startsWith("/")) {
    anchored = true;
    body = body.slice(1);
  } else if (body.includes("/")) {
    anchored = true;
  }
  const glob = body === "" ? null : compileGlobBody(body);
  if (glob === null) {
    return { kind: "unsupported", source: trimmed };
  }
  const head = anchored ? "^" : "(?:^|/)";
  const tail = directoryOnly ? "/.+$" : "(?:/.+)?$";
  const expression = new RegExp(head + glob + tail);
  return {
    kind: "pattern",
    negated,
    matches: (relPath) => expression.test(relPath),
  };
}

/**
 * The filter npm applies when it packs this manifest's directory.
 *
 * A `files` array is an allow list and takes precedence; without one npm falls
 * back to `.npmignore` as a deny list.
 *
 * @param {{files?: string[], npmignore?: string}} input The manifest's `files` and the directory's `.npmignore`.
 * @returns {{kind: string, entries: object[]}} The compiled filter.
 */
function publishFilter({ files, npmignore }) {
  if (Array.isArray(files)) {
    return { kind: "files", entries: files.map(parsePublishPattern) };
  }
  return {
    kind: "npmignore",
    entries: (npmignore ?? "").split("\n").map(parsePublishPattern),
  };
}

/**
 * Whether the packed tarball carries one repo-relative path.
 *
 * @param {string} relPath A path relative to the package directory.
 * @param {{kind: string, entries: object[]}} filter From {@link publishFilter}.
 * @returns {string} `INCLUDED`, `EXCLUDED`, or `UNDECIDABLE`.
 */
function classifyPublishedPath(relPath, filter) {
  const normalized = relPath.replace(/^\.\//, "");
  if (ALWAYS_PUBLISHED.has(normalized)) {
    return "INCLUDED";
  }
  if (filter.entries.some((entry) => entry.kind === "unsupported")) {
    return "UNDECIDABLE";
  }
  let selected = false;
  for (const entry of filter.entries) {
    if (entry.kind !== "pattern" || !entry.matches(normalized)) {
      continue;
    }
    selected = !entry.negated;
  }
  if (filter.kind === "files") {
    return selected ? "INCLUDED" : "EXCLUDED";
  }
  return selected ? "EXCLUDED" : "INCLUDED";
}

/**
 * The repo-relative paths one script command names.
 *
 * Whitespace is not the unit, because a path can sit inside a quoted argument;
 * the unit is a run of two or more path segments. A run preceded by `/` is an
 * absolute path or a URL authority and belongs to neither this package nor this
 * rule. Backslash-separated paths are out of scope: npm hands these to `sh` on
 * the machine that installs them.
 *
 * @param {string} command The script command.
 * @returns {string[]} Repo-relative paths, in first-seen order.
 */
function repoRelativePathTokens(command) {
  const found = [];
  for (const match of command.matchAll(PATH_RUN)) {
    if (command.slice(0, match.index).endsWith("/")) {
      continue;
    }
    const token = match[0].replace(/^\.\//, "");
    if (token.startsWith("node_modules/") || found.includes(token)) {
      continue;
    }
    found.push(token);
  }
  return found;
}

/**
 * Every consumer-install script path the published package would not carry.
 *
 * @param {object} manifest A package manifest.
 * @param {{kind: string, entries: object[]}} filter From {@link publishFilter}.
 * @returns {{event: string, path: string, verdict: string}[]} One finding per offending path.
 */
function consumerInstallFindings(manifest, filter) {
  const findings = [];
  for (const event of CONSUMER_INSTALL_EVENTS) {
    const command = manifest.scripts?.[event];
    if (typeof command !== "string") {
      continue;
    }
    for (const candidate of repoRelativePathTokens(command)) {
      const verdict = classifyPublishedPath(candidate, filter);
      if (verdict !== "INCLUDED") {
        findings.push({ event, path: candidate, verdict });
      }
    }
  }
  return findings;
}

const npmignoreText = readFileSync(path.join(REPO_ROOT, ".npmignore"), {
  encoding: "utf8",
});
const rootPublishFilter = publishFilter({
  files: packageJson.files,
  npmignore: npmignoreText,
});

test("no consumer-install script of the root package names a path the tarball drops", () => {
  const findings = consumerInstallFindings(packageJson, rootPublishFilter);
  assert.deepEqual(
    findings,
    [],
    "every install of this package as a dependency would run these and fail: " +
      findings
        .map((finding) => finding.event + " -> " + finding.path)
        .join(" | "),
  );
});

test("the same rule over the published workspaces", () => {
  for (const { path: manifestPath, manifest } of workspaceManifests()) {
    const findings = consumerInstallFindings(
      manifest,
      publishFilter({ files: manifest.files }),
    );
    assert.deepEqual(
      findings,
      [],
      manifestPath +
        " would fail a consumer install: " +
        findings
          .map((finding) => finding.event + " -> " + finding.path)
          .join(" | "),
    );
  }
});

test("the defect this rule exists for: postinstall reaching into an excluded directory", () => {
  // The manifest shape that shipped, against the real .npmignore. The
  // `/scripts/` rule there is upstream-inherited; the postinstall entry was not.
  const findings = consumerInstallFindings(
    { scripts: { postinstall: "node scripts/patchEslintSeatbelt.mjs" } },
    rootPublishFilter,
  );
  assert.deepEqual(findings, [
    {
      event: "postinstall",
      path: "scripts/patchEslintSeatbelt.mjs",
      verdict: "EXCLUDED",
    },
  ]);
});

test("a consumer-install script naming a published path is fine", () => {
  assert.deepEqual(
    consumerInstallFindings(
      { scripts: { postinstall: "node Build/Cesium/index.cjs" } },
      rootPublishFilter,
    ),
    [],
  );
});

test("prepare may name an excluded path, because npm does not run it for a dependency", () => {
  // Not a loophole and not an oversight: it is the whole reason the fix is a
  // lifecycle rename rather than a packaging change. The real `prepare` names
  // scripts/isCI.js, which the same `/scripts/` rule excludes, and that has
  // never broken a consumer install - npm runs `prepare` for a bare local
  // install, a git dependency and a pack, never for a package unpacked from a
  // tarball into node_modules.
  assert.match(packageJson.scripts.prepare, /scripts\/isCI\.js/);
  assert.equal(
    classifyPublishedPath("scripts/isCI.js", rootPublishFilter),
    "EXCLUDED",
  );
  assert.deepEqual(consumerInstallFindings(packageJson, rootPublishFilter), []);
});

test("a files allow list decides the same question the other way round", () => {
  const shipped = publishFilter({
    files: ["index.js", "Source", "tools/*.mjs"],
  });
  assert.equal(classifyPublishedPath("index.js", shipped), "INCLUDED");
  assert.equal(classifyPublishedPath("Source/Cesium.js", shipped), "INCLUDED");
  assert.equal(classifyPublishedPath("tools/run.mjs", shipped), "INCLUDED");
  assert.equal(
    classifyPublishedPath("tools/deep/run.mjs", shipped),
    "EXCLUDED",
  );
  assert.equal(classifyPublishedPath("scripts/patch.mjs", shipped), "EXCLUDED");
  assert.deepEqual(
    consumerInstallFindings(
      { files: ["index.js"], scripts: { install: "node scripts/build.mjs" } },
      publishFilter({ files: ["index.js"] }),
    ),
    [{ event: "install", path: "scripts/build.mjs", verdict: "EXCLUDED" }],
  );
});

test("a negation re-publishes what an earlier pattern dropped", () => {
  const filter = publishFilter({
    npmignore: "/scripts/\n!/scripts/keep.mjs\n",
  });
  assert.equal(classifyPublishedPath("scripts/drop.mjs", filter), "EXCLUDED");
  assert.equal(classifyPublishedPath("scripts/keep.mjs", filter), "INCLUDED");
  assert.deepEqual(
    consumerInstallFindings(
      { scripts: { postinstall: "node scripts/keep.mjs" } },
      filter,
    ),
    [],
  );
});

test("the real .npmignore is inside the grammar this rule understands", () => {
  const unsupported = rootPublishFilter.entries
    .filter((entry) => entry.kind === "unsupported")
    .map((entry) => entry.source);
  assert.deepEqual(
    unsupported,
    [],
    "the publish filter can no longer be decided for: " +
      unsupported.join(" | "),
  );
});

test("a pattern outside the grammar is reported, never waved through", () => {
  // A guard that silently passes what it cannot parse is worse than no guard:
  // it reads green for exactly the manifests nobody has checked.
  const filter = publishFilter({ npmignore: "/scripts/[a-z]*.mjs\n" });
  assert.equal(
    classifyPublishedPath("scripts/patch.mjs", filter),
    "UNDECIDABLE",
  );
  assert.deepEqual(
    consumerInstallFindings(
      { scripts: { postinstall: "node scripts/patch.mjs" } },
      filter,
    ),
    [
      {
        event: "postinstall",
        path: "scripts/patch.mjs",
        verdict: "UNDECIDABLE",
      },
    ],
  );
});

test("a command yields its repo-relative paths and nothing else", () => {
  assert.deepEqual(repoRelativePathTokens("node scripts/patch.mjs"), [
    "scripts/patch.mjs",
  ]);
  assert.deepEqual(repoRelativePathTokens("node ./scripts/patch.mjs --quiet"), [
    "scripts/patch.mjs",
  ]);
  assert.deepEqual(
    repoRelativePathTokens(
      "gulp prepare && husky && node scripts/isCI.js || playwright install --with-deps",
    ),
    ["scripts/isCI.js"],
  );
  assert.deepEqual(
    repoRelativePathTokens("node -e \"import('./scripts/patch.mjs')\""),
    ["scripts/patch.mjs"],
  );
  assert.deepEqual(repoRelativePathTokens("echo done"), []);
  assert.deepEqual(repoRelativePathTokens("curl https://host.tld/a/b"), []);
  assert.deepEqual(repoRelativePathTokens("/usr/bin/env node"), []);
  assert.deepEqual(repoRelativePathTokens("node node_modules/.bin/thing"), []);
});
