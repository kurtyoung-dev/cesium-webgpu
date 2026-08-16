// comment-marker-guard.spec.mjs — contract for the fork comment standard's
// lint guard.
// @purpose node:test contract for the C16 marker guard: rules still match (self-test vs broken rule), scope does not overreach, ratchet honest both ways.
// @status ACTIVE
//
// Run: node --test Tools/c16/comment-marker-guard.spec.mjs
//
// THREE THINGS THIS PINS, in descending order of how expensive they would be
// to discover later:
//
//   1. THE GUARD CAN STILL SEE. A regex that has stopped matching reports a
//      clean tree, and a clean tree is the answer Campaign 16 is trying to
//      earn. Every rule is driven against its own example, and the self-test
//      is itself driven against a deliberately broken rule so the check is
//      known to be capable of failing.
//   2. THE GUARD DOES NOT OVERREACH. Development history is SUPPOSED to live
//      in migration_doc, Tools, Specs and commit messages. A guard that
//      spread into those would be reverted within a week, taking the code
//      coverage with it.
//   3. THE RATCHET IS HONEST. A clean-list entry means "this was remediated
//      and stays remediated". Both halves are exercised end to end against
//      real files: a marker under a listed path is an error even without
//      --strict, and a marker outside one is a warning until --strict.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectScopeFiles,
  isCleanListed,
  isInScope,
  readCleanList,
  scanSource,
  toRepoRelative,
} from "./comment-marker-guard.mjs";
import {
  MARKER_RULES,
  findMarkers,
  selfTestRules,
} from "./lib/marker-grammar.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GUARD = fileURLToPath(
  new URL("./comment-marker-guard.mjs", import.meta.url),
);
const STANDARD_DOC = path.join(
  ROOT,
  "Documentation",
  "Contributors",
  "CodingGuide",
  "ForkCommentStandard.md",
);

/**
 * Run the guard and capture its exit status and combined output.
 *
 * @param {string[]} args Guard arguments.
 * @returns {{status: number, output: string}} Result.
 */
function runGuard(args) {
  try {
    const output = execFileSync(process.execPath, [GUARD, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1e8,
    });
    return { status: 0, output };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

/**
 * Write fixtures into the real source tree, run `body`, then always remove
 * them. The paths have to be real in-scope paths — a fixture in a temp
 * directory would prove nothing about the scope predicate, which is one of
 * the things under test.
 *
 * @param {Record<string, string>} files Repo-relative path -> contents.
 * @param {() => void} body Test body.
 */
function withSourceFixtures(files, body) {
  const paths = Object.keys(files).map((rel) => path.join(ROOT, rel));
  // Clear first: a hard-killed earlier run could have left one behind, and a
  // stale fixture would fail the NEXT run for the wrong reason.
  for (const full of paths) {
    fs.rmSync(full, { force: true });
  }
  try {
    for (const [rel, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
      fs.writeFileSync(path.join(ROOT, rel), contents);
    }
    body();
  } finally {
    for (const full of paths) {
      fs.rmSync(full, { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 1. The guard can still see.
// ---------------------------------------------------------------------------

test("every marker rule matches its own example", () => {
  assert.deepEqual(
    selfTestRules(),
    [],
    "a rule that no longer matches its example reports a clean tree",
  );
  for (const rule of MARKER_RULES) {
    const found = findMarkers(rule.example).map((f) => f.ruleId);
    assert.ok(
      found.includes(rule.id),
      `${rule.id} did not fire through findMarkers on its own example`,
    );
  }
});

test("the self-test itself is capable of failing", () => {
  // A negative control for the negative control. Without this, `selfTestRules`
  // could be `return []` and every assertion above would still pass.
  assert.deepEqual(
    selfTestRules([
      { id: "broken", pattern: /never-matches/g, example: "Batch 12" },
    ]),
    ["broken"],
  );
  assert.deepEqual(
    selfTestRules([
      { id: "not-global", pattern: /Batch \d+/, example: "Batch 12" },
    ]),
    ["not-global"],
    "a non-global pattern silently reports one occurrence per file",
  );
});

test("the guard exits 3 (STRUCTURAL) rather than 0 when it can see nothing", () => {
  // Proven end to end by the CLI's own path: `--verify-cleanlist` refuses to
  // certify against an empty coverage set.
  const result = runGuard([
    "--verify-cleanlist",
    "packages/engine/Source/Core/Cartesian3.js",
  ]);
  assert.equal(
    result.status,
    3,
    `a check that covers nothing must be structural:\n${result.output}`,
  );
  assert.match(result.output, /STRUCTURAL/);
});

test("markers are read from comments only, never from code or strings", () => {
  const subject = "packages/engine/Source/Renderer/WebGPU/Subject.ts";

  const inComment = scanSource(
    subject,
    "// Batch 812 landed this.\nconst a = 1;\n",
  );
  assert.equal(inComment.length, 1);
  assert.equal(inComment[0].ruleId, "batch-id");
  assert.equal(inComment[0].line, 1);

  const inString = scanSource(
    subject,
    'const label = "Batch 812";\nconst id = "C13-10";\n',
  );
  assert.deepEqual(
    inString,
    [],
    "a marker-shaped string literal is data, not a comment",
  );

  const inIdentifier = scanSource(
    subject,
    "const DP_H41 = 1;\nconst x = C13;\n",
  );
  assert.deepEqual(inIdentifier, []);
});

test("the reported line is the marker's line, not the docblock's first line", () => {
  const subject = "packages/engine/Source/Renderer/WebGPU/Subject.ts";
  const source = [
    "/**",
    " * Summary.",
    " *",
    " * Landed in Batch 731.",
    " */",
    "const a = 1;",
    "",
  ].join("\n");
  const findings = scanSource(subject, source);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
});

test("shader comments are scanned with the shader grammar", () => {
  const wgsl = scanSource(
    "packages/engine/Source/Shaders/WebGPU/Subject.wgsl",
    "// C13-10 variant\nfn f() -> f32 { return 1.0; }\n",
  );
  assert.equal(wgsl.length, 1);
  assert.equal(wgsl[0].ruleId, "campaign-row-id");

  const glsl = scanSource(
    "packages/engine/Source/Shaders/SubjectFS.glsl",
    "/* DP-H41 note */\nvoid main() {}\n",
  );
  assert.equal(glsl.length, 1);
  assert.equal(glsl[0].ruleId, "dp-h-id");
});

test("ordinary engineering prose does not trip the grammar", () => {
  // The precision half of the contract. A guard that fires on normal comments
  // trains reviewers to ignore it, which costs more than the rule is worth.
  const prose = [
    "// Uploads the tile in batches of 64 to stay under the 32 KB limit.",
    "// The C1 continuity requirement means the tangent must be normalised.",
    "// See Karis 2013 for the split-sum approximation.",
    "// A session token is refreshed every 3600 seconds.",
    "// Fixed in v1.144; the upstream issue number is 12345.",
  ].join("\n");
  assert.deepEqual(
    scanSource("packages/engine/Source/Scene/Subject.js", prose),
    [],
  );
});

// ---------------------------------------------------------------------------
// 2. The guard does not overreach.
// ---------------------------------------------------------------------------

test("scope is engine and widgets source only", () => {
  for (const inScope of [
    "packages/engine/Source/Scene/Globe.js",
    "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
    "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    "packages/engine/Source/Shaders/GlobeFS.glsl",
    "packages/widgets/Source/Viewer/Viewer.js",
  ]) {
    assert.equal(isInScope(inScope), true, `${inScope} must be in scope`);
  }

  for (const outOfScope of [
    // Development history is SUPPOSED to live in these.
    "migration_doc/QUEUE_2026-08-10_CAMPAIGN16.md",
    "migration_doc/DEV_NOTES_CLOUDS.md",
    "Tools/visual-regression/probe-cloud-march-emission.mjs",
    "Tools/c16/comment-marker-guard.mjs",
    "Specs/Renderer/UniformStateSpec.js",
    "packages/engine/Specs/Scene/GlobeSpec.js",
    "CLAUDE.md",
    "scripts/build.js",
    "Apps/CesiumViewer/main.js",
    // Vendored upstream source we do not own.
    "packages/engine/Source/ThirdParty/naga-wasm/naga_wasm.js",
    // Build output, never the source of truth.
    "Source/Scene/Globe.js",
    // In scope by path, but no comment grammar covers it.
    "packages/engine/Source/Assets/Textures/moonSmall.jpg",
  ]) {
    assert.equal(isInScope(outOfScope), false, `${outOfScope} must be exempt`);
  }
});

test("the CLI skips out-of-scope paths without failing", () => {
  const result = runGuard([
    "--strict",
    "migration_doc/QUEUE_2026-08-10_CAMPAIGN16.md",
    "Tools/c16/comment-marker-guard.mjs",
    "CLAUDE.md",
  ]);
  assert.equal(
    result.status,
    0,
    `history-bearing paths must never fail the guard:\n${result.output}`,
  );
  assert.match(result.output, /no in-scope files/);
});

test("absolute paths from lint-staged normalize into scope", () => {
  const absolute = path.join(
    ROOT,
    "packages",
    "engine",
    "Source",
    "Scene",
    "Globe.js",
  );
  assert.equal(
    toRepoRelative(absolute),
    "packages/engine/Source/Scene/Globe.js",
  );
  assert.equal(isInScope(toRepoRelative(absolute)), true);
});

// ---------------------------------------------------------------------------
// 3. The ratchet is honest.
// ---------------------------------------------------------------------------

test("clean-list matching is path-segment exact", () => {
  const list = ["packages/engine/Source/Workers"];
  assert.equal(
    isCleanListed("packages/engine/Source/Workers/a.js", list),
    true,
  );
  assert.equal(isCleanListed("packages/engine/Source/Workers", list), true);
  assert.equal(
    isCleanListed("packages/engine/Source/WorkersExtra/a.js", list),
    false,
    "a prefix match must not leak into a sibling directory",
  );
});

test("the shipped clean list is non-empty and still clean", () => {
  const result = runGuard(["--verify-cleanlist"]);
  assert.equal(
    result.status,
    0,
    `the ratchet has regressed or gone stale:\n${result.output}`,
  );
  assert.match(result.output, /covering (\d+) of/);
  const covered = Number(result.output.match(/covering (\d+) of/)[1]);
  assert.ok(
    covered > 0,
    "an empty clean list makes --verify-cleanlist prove nothing",
  );
});

test("a clean-list entry that matches no file is reported DEAD", async () => {
  // The half that stops a rename from silently retiring an entry.
  const files = await collectScopeFiles();
  const cleanList = await readCleanList();
  assert.ok(cleanList.length > 0);
  for (const entry of cleanList) {
    assert.ok(
      files.some((file) => file === entry || file.startsWith(`${entry}/`)),
      `clean-list entry "${entry}" matches no in-scope file`,
    );
  }
});

test("clean-listed paths are ERRORS; unlisted paths are warnings until --strict", () => {
  const cleanListed = "packages/widgets/Source/C16GuardFixture.js";
  const pending = "packages/engine/Source/Scene/C16GuardFixture.js";
  const dirty = "// Batch 999 wired this up.\nexport const fixture = 1;\n";
  const clean = "// Wires the fixture up.\nexport const fixture = 1;\n";

  withSourceFixtures({ [cleanListed]: dirty, [pending]: dirty }, () => {
    const listed = runGuard([cleanListed]);
    assert.equal(
      listed.status,
      1,
      `a marker under a certified path must fail without --strict:\n${listed.output}`,
    );
    assert.match(listed.output, /ERRORS/);

    const unlisted = runGuard([pending]);
    assert.equal(
      unlisted.status,
      0,
      `an unremediated path is warn-only until its shard lands:\n${unlisted.output}`,
    );

    const strict = runGuard(["--strict", pending]);
    assert.equal(
      strict.status,
      1,
      "--strict is what the rewrite shards flip; it must fail on the same file",
    );
  });

  // POSITIVE CONTROL: the same fixture shape with no marker passes everywhere.
  // Without it, a guard that failed for an unrelated reason (unreadable path,
  // bad argument) would read as working enforcement.
  withSourceFixtures({ [cleanListed]: clean, [pending]: clean }, () => {
    assert.equal(runGuard([cleanListed]).status, 0);
    assert.equal(runGuard(["--strict", cleanListed, pending]).status, 0);
  });
});

// ---------------------------------------------------------------------------
// The hook wiring. A guard nobody runs is a guard that does not exist.
// ---------------------------------------------------------------------------

test("lint-staged routes engine and widgets source through the guard", async () => {
  const config = (
    await import(new URL("../../lint-staged.config.js", import.meta.url))
  ).default;
  const guardGlob = Object.keys(config).find((key) =>
    key.startsWith("packages/"),
  );
  assert.ok(guardGlob, "no lint-staged entry targets packages/*/Source");

  // Every extension the standard covers has to be named, or the hook lets
  // through what the one-shot scan then reports.
  for (const extension of ["js", "mjs", "cjs", "ts", "wgsl", "glsl"]) {
    assert.ok(
      guardGlob.includes(extension),
      `lint-staged glob does not name .${extension}`,
    );
  }

  const commands = config[guardGlob]([
    "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    "packages/widgets/Source/Viewer/Viewer.js",
  ]);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /comment-marker-guard\.mjs/);

  // Vendored trees stay out, matching the guard's own scope predicate.
  assert.deepEqual(
    config[guardGlob](["packages/engine/Source/ThirdParty/naga-wasm/x.js"]),
    [],
  );
});

test("lint-staged's markdownlint exemptions mirror .markdownlintignore", async () => {
  // markdownlint-cli does not apply its ignore file to explicitly-named paths,
  // and lint-staged always names paths explicitly. When the two disagree the
  // hook rejects documents CI never looks at — which is what would happen to
  // every DEV notes file this campaign writes.
  const config = (
    await import(new URL("../../lint-staged.config.js", import.meta.url))
  ).default;
  const ignoreText = fs.readFileSync(
    path.join(ROOT, ".markdownlintignore"),
    "utf8",
  );
  for (const ignored of ["/migration_doc/**", "/Tools/**", "LICENSE.md"]) {
    assert.ok(
      ignoreText.includes(ignored),
      `.markdownlintignore no longer lists ${ignored}; the mirror below is stale`,
    );
  }

  const commands = config["*.md"]([
    "migration_doc/DEV_NOTES_CLOUDS.md",
    "Tools/visual-regression/README.md",
    "LICENSE.md",
  ]);
  assert.ok(
    commands.every((command) => !command.startsWith("markdownlint")),
    `ignored markdown must not be linted by the hook: ${commands.join(" | ")}`,
  );

  // POSITIVE CONTROL: markdown CI does check still runs through the hook.
  const checked = config["*.md"](["Documentation/Contributors/README.md"]);
  assert.ok(checked.some((command) => command.startsWith("markdownlint")));
});

// ---------------------------------------------------------------------------
// The standard and the guard must agree with each other.
// ---------------------------------------------------------------------------

test("the standards document exists and its code examples carry no markers", () => {
  const text = fs.readFileSync(STANDARD_DOC, "utf8");

  // The guard's scope is source, so the document is exempt as a FILE, exactly
  // like migration_doc — the CLI confirms that below. What must hold is the
  // substantive claim: nothing the document presents as an example of correct
  // code contains a marker, and the "before" example is anonymized so the
  // document is not itself a carrier.
  // `\r?\n`, not `\n`: the working tree is CRLF and this assertion is the one
  // that silently stops finding anything if it assumes otherwise.
  const fences = [...text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map(
    (m) => m[1],
  );
  assert.ok(fences.length >= 2, "expected worked examples in fenced blocks");
  for (const block of fences) {
    const found = findMarkers(block);
    assert.deepEqual(
      found.map((f) => `${f.ruleId}:${f.match}`),
      [],
      "a code example in the standard must not contain a live tracker marker",
    );
  }

  assert.equal(
    runGuard([path.relative(ROOT, STANDARD_DOC)]).status,
    0,
    "the standard is a document, not source; the guard must skip it",
  );
});

test("every rule id in the grammar is documented in the standard", () => {
  const text = fs.readFileSync(STANDARD_DOC, "utf8");
  for (const rule of MARKER_RULES) {
    assert.ok(
      text.includes(rule.id),
      `rule "${rule.id}" is enforced but not documented in the standard`,
    );
  }
});
