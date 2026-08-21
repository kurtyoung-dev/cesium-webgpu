// verify-tracked-references.spec.mjs — contract for the claim-vs-tree guard.
// @purpose Contract for the tracked-reference guard: mutation controls where a tracked referrer points at an untracked target must red, and the all-tracked control must stay green.
// @status ACTIVE
//
// Run: node --test Tools/verify-tracked-references.spec.mjs
//
// WHAT MAKES THIS SPEC WORTH ANYTHING. A guard that always fails and a guard
// that never fails are equally useless, and only a PAIR separates them. Every
// mutation control in group D is therefore two runs over inputs that differ in
// exactly one bit — one path's membership in the tracked set — and the pair
// asserts FAIL then PASS. If the negative leg ever goes green, the guard has
// stopped reading the tree; if the positive leg ever goes red, it has stopped
// reading anything at all.
//
// WHY THE FIXTURES ARE INJECTED TREES AND NOT TEMP GIT REPOS. Workers in this
// campaign may not run git write commands, and `git init && git add && git
// commit` in a throwaway directory is still a git write. The tree is therefore
// an injected adapter — a set of tracked paths, a file reader, a changed-file
// list — which is the same interface the real adapters implement. THE COST,
// STATED PLAINLY: the git plumbing itself (`ls-files`, `ls-tree`, `diff-tree`,
// `check-ignore`, `status --porcelain -z`) is exercised only by group E, which
// runs the real CLI against this repository read-only. Group E is what keeps
// group D from being a test of a mock.
//
// THE CRLF TRAP. This checkout is `core.autocrlf=true`, and at Batch 1048 a
// source-replace mutant written with literal "\n" was a silent no-op against
// CRLF bytes, which produced a false green. D6 therefore runs a CRLF fixture
// and its LF twin through the same assertions and requires identical findings.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parsePurposeHeader } from "./lib/purpose-header.mjs";
import { S5_STATUS_EXIT_CODES } from "./visual-regression/lib/verdict-exit-gate.mjs";
import {
  DISPOSITIONS,
  moduleReferences,
  moduleSystemFor,
  nodeTargetsFromCommand,
  packageScriptReferences,
  resolutionCandidates,
  splitShellCommands,
  verifyTrackedReferences,
} from "./verify-tracked-references.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TOOL = fileURLToPath(
  new URL("./verify-tracked-references.mjs", import.meta.url),
);
const CLI_TIMEOUT_MS = 180_000;

/**
 * Run the CLI as a subprocess.
 *
 * @param {string[]} args CLI arguments.
 * @param {string} [cwd] Working directory.
 * @returns {{status: number, stdout: string, stderr: string}} Result.
 */
function runCli(args, cwd = ROOT) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    cwd,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
  assert.equal(result.error, undefined, `CLI failed to spawn: ${result.error}`);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * An injected tree adapter over an in-memory file map.
 *
 * @param {object} options Fixture description.
 * @param {Record<string,string>} options.files Path -> source.
 * @param {string[]} options.tracked Paths the tree tracks.
 * @param {string[]} options.changed Paths reported as changed.
 * @returns {object} Tree adapter.
 */
function fixtureTree({ files, tracked, changed }) {
  return {
    label: "fixture",
    rev: null,
    tracked: new Set(tracked),
    read: (filePath) =>
      Object.hasOwn(files, filePath) ? files[filePath] : null,
    changedFiles: () => changed,
  };
}

/**
 * Run the checker over a fixture.
 *
 * @param {object} options Fixture description.
 * @param {Record<string,string>} options.files Path -> source.
 * @param {string[]} options.tracked Tracked paths.
 * @param {string[]} options.changed Changed paths.
 * @param {string[]} [options.onDisk] Paths that exist on disk.
 * @param {string[]} [options.ignored] Paths git ignores.
 * @returns {object} The report.
 */
function runFixture({ files, tracked, changed, onDisk = [], ignored = [] }) {
  const diskSet = new Set([...onDisk, ...Object.keys(files)]);
  const ignoredSet = new Set(ignored);
  return verifyTrackedReferences({
    tree: fixtureTree({ files, tracked, changed }),
    onDisk: (candidate) => diskSet.has(candidate),
    ignored: (paths) => new Set(paths.filter((p) => ignoredSet.has(p))),
  });
}

// ---------------------------------------------------------------------------
// A — launch-target extraction
// ---------------------------------------------------------------------------

test("A1 a plain node invocation yields its script path", () => {
  assert.deepEqual(nodeTargetsFromCommand(["node", "Tools/x.mjs"]), [
    "Tools/x.mjs",
  ]);
});

test("A2 --test makes every positional a target", () => {
  const commands = splitShellCommands(
    "node --test Tools/a.spec.mjs Tools/b.spec.mjs Tools/c.spec.mjs",
  );
  assert.equal(commands.length, 1);
  assert.deepEqual(nodeTargetsFromCommand(commands[0]), [
    "Tools/a.spec.mjs",
    "Tools/b.spec.mjs",
    "Tools/c.spec.mjs",
  ]);
});

test("A3 without --test only the first positional is the script", () => {
  // `node server.js --public` has one target, and the second positional in
  // `node foo.js bar.js` is an ARGUMENT to foo.js, not a second script. Reading
  // it as a target would make the guard fail on any script that passes a
  // filename to its own program.
  assert.deepEqual(nodeTargetsFromCommand(["node", "server.js", "--public"]), [
    "server.js",
  ]);
  assert.deepEqual(nodeTargetsFromCommand(["node", "foo.js", "bar.js"]), [
    "foo.js",
  ]);
});

test("A4 command chains are split and only node commands are read", () => {
  const commands = splitShellCommands(
    "gulp clean && node scripts/buildWasm.js && gulp build",
  );
  assert.equal(commands.length, 3);
  const targets = commands.flatMap((tokens) => nodeTargetsFromCommand(tokens));
  assert.deepEqual(targets, ["scripts/buildWasm.js"]);
});

test("A5 an inline program has no script file", () => {
  const commands = splitShellCommands(`node -e "require('./x.js')"`);
  assert.deepEqual(nodeTargetsFromCommand(commands[0]), []);
});

test("A6 --require values are targets, other flag values are not", () => {
  assert.deepEqual(
    nodeTargetsFromCommand([
      "node",
      "--require",
      "./preload.cjs",
      "Tools/x.mjs",
    ]),
    ["preload.cjs", "Tools/x.mjs"],
  );
  assert.deepEqual(
    nodeTargetsFromCommand([
      "node",
      "--test-reporter",
      "spec",
      "Tools/x.spec.mjs",
    ]),
    ["Tools/x.spec.mjs"],
  );
});

test("A7 quoting is honoured and non-node commands yield nothing", () => {
  const quoted = splitShellCommands(`markdownlint "**/*.md"`);
  assert.deepEqual(nodeTargetsFromCommand(quoted[0]), []);
  const spaced = splitShellCommands(`node "Tools/a b.mjs"`);
  assert.deepEqual(nodeTargetsFromCommand(spaced[0]), ["Tools/a b.mjs"]);
});

test("A8 package.json scripts are read with their line numbers", () => {
  const source = [
    "{",
    '  "scripts": {',
    '    "alpha": "node Tools/alpha.mjs",',
    '    "beta": "node Tools/beta.mjs --check"',
    "  }",
    "}",
  ].join("\n");
  const references = packageScriptReferences(source);
  assert.deepEqual(
    references.map((r) => [r.specifier, r.line, r.detail]),
    [
      ["Tools/alpha.mjs", 3, "scripts.alpha"],
      ["Tools/beta.mjs", 4, "scripts.beta"],
    ],
  );
});

// ---------------------------------------------------------------------------
// B — specifier extraction is string-aware
// ---------------------------------------------------------------------------

test("B1 every reference form is found", () => {
  const source = [
    `import a from "./a.mjs";`,
    `export { b } from "./b.mjs";`,
    `const c = require("./c.cjs");`,
    `await import("./d.mjs");`,
    `import "./e.mjs";`,
  ].join("\n");
  assert.deepEqual(
    moduleReferences(source).map((r) => r.specifier),
    ["./a.mjs", "./b.mjs", "./c.cjs", "./d.mjs", "./e.mjs"],
  );
});

test("B2 a specifier inside a comment is not a reference", () => {
  const source = `// import x from "./ghost.mjs";\nconst y = 1;\n`;
  assert.deepEqual(moduleReferences(source), []);
});

test("B3 a specifier inside a template literal is not a reference", () => {
  // This repository has fixture specs that EMBED module source as a template
  // literal. A byte-level regex reports every one of them, and a guard that
  // cries wolf on its own test fixtures gets switched off.
  const source = 'const fixture = `import x from "./ghost.mjs";`;\n';
  assert.deepEqual(moduleReferences(source), []);
});

test("B4 a path in a data array is not a reference", () => {
  const source = `const files = ["./a.mjs", "./b.mjs"];\nreadSource("./c.mjs");\n`;
  assert.deepEqual(moduleReferences(source), []);
});

test("B5 a comment between `from` and its specifier does not hide it", () => {
  const source = `import x from /* pinned */ "./real.mjs";\n`;
  assert.deepEqual(
    moduleReferences(source).map((r) => r.specifier),
    ["./real.mjs"],
  );
});

test("B6 line numbers are 1-indexed and correct under CRLF", () => {
  const lf = `const a = 1;\nconst b = 2;\nimport x from "./t.mjs";\n`;
  const crlf = lf.split("\n").join("\r\n");
  assert.equal(moduleReferences(lf)[0].line, 3);
  assert.equal(moduleReferences(crlf)[0].line, 3);
});

// ---------------------------------------------------------------------------
// C — resolution
// ---------------------------------------------------------------------------

test("C1 a .js specifier may be satisfied by a TypeScript sibling", () => {
  const { candidates } = resolutionCandidates(
    "packages/engine/Source/Scene/PointCloud.js",
    "../Renderer/GraphicsContext.js",
    "esm",
  );
  assert.ok(
    candidates.includes("packages/engine/Source/Renderer/GraphicsContext.js"),
  );
  assert.ok(
    candidates.includes("packages/engine/Source/Renderer/GraphicsContext.ts"),
  );
});

test("C2 ESM does no extension or index resolution", () => {
  const { candidates } = resolutionCandidates(
    "Tools/x.mjs",
    "./lib/thing",
    "esm",
  );
  assert.deepEqual(candidates, ["Tools/lib/thing"]);
});

test("C3 CJS resolves extensions and index files", () => {
  const { candidates } = resolutionCandidates(
    "Tools/x.cjs",
    "./lib/thing",
    "cjs",
  );
  assert.ok(candidates.includes("Tools/lib/thing.js"));
  assert.ok(candidates.includes("Tools/lib/thing/index.js"));
});

test("C4 a specifier that escapes the repository root is external", () => {
  const resolution = resolutionCandidates(
    "Tools/x.mjs",
    "../../outside.mjs",
    "esm",
  );
  assert.equal(resolution.external, true);
});

test("C5 the module system follows the NEAREST package.json", () => {
  // Real divergence in this repository: root declares "module", Tools declares
  // "commonjs". A single global answer would misresolve one of the two.
  const declared = (dir) => {
    if (dir === "Tools") {
      return "commonjs";
    }
    if (dir === "") {
      return "module";
    }
    return null;
  };
  assert.equal(moduleSystemFor("Tools/thing.js", declared), "cjs");
  assert.equal(moduleSystemFor("scripts/thing.js", declared), "esm");
  assert.equal(moduleSystemFor("Tools/thing.mjs", declared), "esm");
  assert.equal(moduleSystemFor("Tools/thing.cjs", declared), "cjs");
});

// ---------------------------------------------------------------------------
// D — mutation controls (each is a FAIL/PASS pair over a one-bit difference)
// ---------------------------------------------------------------------------

/** The launch-target fixture, reused by its negative and positive legs. */
const LAUNCH_FIXTURE = {
  files: {
    "package.json": [
      "{",
      '  "scripts": {',
      '    "verify-catalog": "node Tools/catalog-launcher.cjs --check"',
      "  }",
      "}",
    ].join("\n"),
    "Tools/catalog-launcher.cjs": "module.exports = {};\n",
  },
  changed: [],
};

test("D1 NEGATIVE — a tracked script pointing at an untracked launcher reds", () => {
  const report = runFixture({
    ...LAUNCH_FIXTURE,
    tracked: ["package.json"],
  });
  assert.equal(report.status, "FAIL");
  assert.equal(report.violations.length, 1);
  const [finding] = report.violations;
  assert.equal(finding.target, "Tools/catalog-launcher.cjs");
  assert.equal(finding.disposition, DISPOSITIONS.UNTRACKED);
  assert.equal(finding.referencing, "package.json");
  assert.equal(finding.detail, "scripts.verify-catalog");
  assert.equal(finding.line, 3);
});

test("D2 POSITIVE — the same fixture with the launcher tracked stays green", () => {
  // One bit of difference from D1: the launcher is in the tracked set. If this
  // leg ever reds, the guard is not reading the tree at all.
  const report = runFixture({
    ...LAUNCH_FIXTURE,
    tracked: ["package.json", "Tools/catalog-launcher.cjs"],
  });
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.violations, []);
  assert.equal(report.scanned.launchTargets, 1);
});

/** The module-import fixture, reused by its negative and positive legs. */
const IMPORT_FIXTURE = {
  files: {
    "Tools/probe.mjs": `import { helper } from "./lib/helper.mjs";\nhelper();\n`,
    "Tools/lib/helper.mjs": "export function helper() {}\n",
  },
  changed: ["Tools/probe.mjs"],
};

test("D3 NEGATIVE — a tracked probe importing an untracked lib reds", () => {
  const report = runFixture({
    ...IMPORT_FIXTURE,
    tracked: ["Tools/probe.mjs"],
  });
  assert.equal(report.status, "FAIL");
  assert.equal(report.violations.length, 1);
  const [finding] = report.violations;
  assert.equal(finding.target, "Tools/lib/helper.mjs");
  assert.equal(finding.disposition, DISPOSITIONS.UNTRACKED);
  assert.equal(finding.referencingTracked, true);
  assert.equal(finding.line, 1);
});

test("D4 POSITIVE — the same fixture with the lib tracked stays green", () => {
  const report = runFixture({
    ...IMPORT_FIXTURE,
    tracked: ["Tools/probe.mjs", "Tools/lib/helper.mjs"],
  });
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.violations, []);
  assert.equal(report.scanned.moduleFiles, 1);
  assert.equal(report.scanned.moduleReferences, 1);
});

test("D5 the dangerous case and the broken case are told apart", () => {
  const report = runFixture({
    files: {
      "Tools/probe.mjs": [
        `import a from "./lib/on-disk.mjs";`,
        `import b from "./lib/nowhere.mjs";`,
      ].join("\n"),
      "Tools/lib/on-disk.mjs": "export default 1;\n",
    },
    tracked: ["Tools/probe.mjs"],
    changed: ["Tools/probe.mjs"],
  });
  assert.equal(report.violations.length, 2);
  const byTarget = new Map(report.violations.map((v) => [v.target, v]));
  assert.equal(
    byTarget.get("Tools/lib/on-disk.mjs").disposition,
    DISPOSITIONS.UNTRACKED,
  );
  assert.equal(
    byTarget.get("Tools/lib/nowhere.mjs").disposition,
    DISPOSITIONS.MISSING,
  );
});

test("D6 CRLF and LF fixtures produce identical findings", () => {
  // The Batch-1048 trap: a mutation written with literal newlines is a silent
  // no-op against CRLF bytes, and the run reads green for the wrong reason.
  const lfSource = `import { helper } from "./lib/helper.mjs";\nhelper();\n`;
  const build = (source) =>
    runFixture({
      files: { "Tools/probe.mjs": source },
      tracked: ["Tools/probe.mjs"],
      changed: ["Tools/probe.mjs"],
    });
  const lf = build(lfSource);
  const crlf = build(lfSource.split("\n").join("\r\n"));
  assert.equal(lf.status, "FAIL");
  assert.equal(crlf.status, "FAIL");
  assert.deepEqual(
    crlf.violations.map((v) => [v.target, v.line, v.disposition]),
    lf.violations.map((v) => [v.target, v.line, v.disposition]),
  );
});

test("D7 a gitignored build artifact is an advisory, not a violation", () => {
  const fixture = {
    files: {
      "packages/engine/Specs/Thing.js": `import { X } from "../index.js";\nX();\n`,
      "packages/engine/index.js": "export const X = 1;\n",
      "package.json": '{ "type": "module" }',
    },
    tracked: ["packages/engine/Specs/Thing.js", "package.json"],
    changed: ["packages/engine/Specs/Thing.js"],
  };
  const ignoredReport = runFixture({
    ...fixture,
    ignored: ["packages/engine/index.js"],
  });
  assert.equal(ignoredReport.status, "PASS");
  assert.equal(ignoredReport.advisories.length, 1);
  assert.equal(ignoredReport.advisories[0].disposition, DISPOSITIONS.IGNORED);

  // MUTATION: the same untracked file with the ignore rule removed is a
  // violation again. Without this leg, D7 would only prove the guard can be
  // silenced, not that silencing requires a declaration.
  const undeclared = runFixture(fixture);
  assert.equal(undeclared.status, "FAIL");
  assert.equal(undeclared.violations[0].disposition, DISPOSITIONS.UNTRACKED);
});

test("D8 an untracked .mcp.json referrer still has its launcher checked", () => {
  const files = {
    ".mcp.json": [
      "{",
      '  "mcpServers": {',
      '    "codex": {',
      '      "command": "node",',
      '      "args": ["Tools/codex-mcp-launcher.mjs", "-c", "x=1"]',
      "    },",
      '    "playwright": {',
      '      "command": "cmd",',
      '      "args": ["/c", "npx", "-y", "@playwright/mcp@latest"]',
      "    }",
      "  }",
      "}",
    ].join("\n"),
    "Tools/codex-mcp-launcher.mjs": "export default 1;\n",
  };
  const report = runFixture({ files, tracked: [], changed: [] });
  assert.equal(report.status, "FAIL");
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].target, "Tools/codex-mcp-launcher.mjs");
  assert.equal(report.violations[0].detail, "mcpServers.codex");
  assert.equal(report.violations[0].referencingTracked, false);

  const green = runFixture({
    files,
    tracked: ["Tools/codex-mcp-launcher.mjs"],
    changed: [],
  });
  assert.equal(green.status, "PASS");
});

test("D9 an unchanged source's imports are not scanned", () => {
  // Layer 2 is scoped to the changed set by design; layer 1 is not. This test
  // pins that asymmetry so a later "scan everything" change is a deliberate
  // decision rather than an accident.
  const report = runFixture({
    files: { "Tools/old.mjs": `import x from "./lib/gone.mjs";\n` },
    tracked: ["Tools/old.mjs"],
    changed: [],
  });
  assert.equal(report.status, "PASS");
  assert.equal(report.scanned.moduleFiles, 0);
});

// ---------------------------------------------------------------------------
// E — end to end against the real repository (read-only git)
// ---------------------------------------------------------------------------

test("E1 the exit codes are the shared frozen table, not a private copy", () => {
  assert.equal(S5_STATUS_EXIT_CODES.PASS, 0);
  assert.equal(S5_STATUS_EXIT_CODES.FAIL, 1);
  assert.equal(S5_STATUS_EXIT_CODES.ERROR, 2);
  assert.equal(S5_STATUS_EXIT_CODES.STRUCTURAL, 3);
  const source = readFileSync(TOOL, "utf8");
  assert.ok(
    source.includes("verdict-exit-gate.mjs"),
    "the guard must import the frozen table",
  );
  assert.ok(
    !/STRUCTURAL\s*:\s*3/.test(source),
    "the guard must not re-declare the exit-code table",
  );
});

test("E2 --rev HEAD is clean on this repository", () => {
  const result = runCli(["--rev", "HEAD"]);
  assert.equal(
    result.status,
    S5_STATUS_EXIT_CODES.PASS,
    `expected PASS, got:\n${result.stdout}\n${result.stderr}`,
  );
});

test("E3 the working tree agrees with an independently derived expectation", () => {
  // The expectation is re-derived here with a DIFFERENT extractor than the
  // guard's, so this is a cross-check rather than a restatement. Whatever the
  // tree happens to hold, every untracked node launch target in package.json
  // must appear in the guard's violations, and the exit code must follow.
  const trackedList = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(trackedList.status, 0, "git ls-files must succeed");
  const tracked = new Set(trackedList.stdout.split("\0").filter(Boolean));

  const scripts = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ).scripts;
  const pattern = /\bnode\s+(?:--?[^\s]+\s+)*([^\s"']+\.(?:mjs|cjs|js))/g;
  const expected = new Set();
  for (const body of Object.values(scripts ?? {})) {
    if (typeof body !== "string") {
      continue;
    }
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(body)) !== null) {
      if (!tracked.has(match[1])) {
        expected.add(match[1]);
      }
    }
  }

  const result = runCli(["--json"]);
  assert.ok(
    result.status === S5_STATUS_EXIT_CODES.PASS ||
      result.status === S5_STATUS_EXIT_CODES.FAIL,
    `expected a verdict, got ${result.status}: ${result.stderr}`,
  );
  const report = JSON.parse(result.stdout);
  const reported = new Set(
    report.violations
      .filter((finding) => finding.rule === "launch-target")
      .map((finding) => finding.target),
  );
  for (const missing of expected) {
    assert.ok(
      reported.has(missing),
      `untracked launch target ${missing} was not reported`,
    );
  }
  assert.equal(
    result.status,
    report.violations.length === 0
      ? S5_STATUS_EXIT_CODES.PASS
      : S5_STATUS_EXIT_CODES.FAIL,
    "the exit code must follow the report",
  );
});

test("E4 an unreadable rev is STRUCTURAL, not a pass and not a fail", () => {
  const result = runCli(["--rev", "definitely-not-a-rev"]);
  assert.equal(result.status, S5_STATUS_EXIT_CODES.STRUCTURAL);
  assert.match(result.stderr, /STRUCTURAL/);
});

test("E5 outside a git repository the guard is STRUCTURAL", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "tracked-refs-"));
  try {
    const result = runCli([], scratch);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.STRUCTURAL);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("E6 a bad argument is ERROR and --help is PASS", () => {
  assert.equal(runCli(["--bogus"]).status, S5_STATUS_EXIT_CODES.ERROR);
  assert.equal(runCli(["--rev"]).status, S5_STATUS_EXIT_CODES.ERROR);
  assert.equal(runCli(["--help"]).status, S5_STATUS_EXIT_CODES.PASS);
});

test("E7 both files carry a parseable purpose header", () => {
  for (const file of [TOOL, fileURLToPath(import.meta.url)]) {
    const header = parsePurposeHeader(readFileSync(file, "utf8"));
    assert.ok(header.purpose, `${path.basename(file)} needs @purpose`);
    assert.equal(header.status, "ACTIVE");
  }
});
