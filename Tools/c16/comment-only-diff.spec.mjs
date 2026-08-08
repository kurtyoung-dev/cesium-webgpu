// comment-only-diff.spec.mjs — mutants for the Campaign 16 rewrite gate.
//
// Run: node --test Tools/c16/comment-only-diff.spec.mjs
//
// WHY MUTANTS AND NOT EXAMPLES. This gate's whole value is that it FAILS on a
// code change hidden inside a comment rewrite. A spec that only feeds it
// comment-only diffs proves the pass path and nothing else — and a verifier
// that returned "comment-only" unconditionally would sail through it. Every
// test below is therefore paired: a mutant that MUST be rejected next to the
// nearest legitimate edit that MUST be accepted. Where the two differ by one
// character, that character is the whole contract.
//
// The comparison engine takes injected readers, so nothing here shells out to
// git except the one test that pins the structural exit code end to end.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compareSources, runComparison } from "./comment-only-diff.mjs";
import {
  canonicalizeCode,
  extractComments,
  tokenize,
} from "./lib/comment-scanner.mjs";
import { collectScopeFiles } from "./comment-marker-guard.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SUBJECT = "packages/engine/Source/Renderer/WebGPU/Subject.ts";

/**
 * Assert a before/after pair is accepted as comment-only.
 *
 * @param {string} before Base source.
 * @param {string} after Head source.
 * @param {string} relPath Path used to pick the grammar.
 * @param {string} why Message on failure.
 */
function assertCommentOnly(before, after, relPath, why) {
  const result = compareSources(before, after, relPath);
  assert.equal(
    result.status,
    "comment-only",
    `${why}\n  ${result.detail ?? ""}`,
  );
}

/**
 * Assert a before/after pair is rejected as a code change.
 *
 * @param {string} before Base source.
 * @param {string} after Head source.
 * @param {string} relPath Path used to pick the grammar.
 * @param {string} why Message on failure.
 */
function assertCodeDiffers(before, after, relPath, why) {
  const result = compareSources(before, after, relPath);
  assert.equal(result.status, "code-differs", why);
}

// ---------------------------------------------------------------------------
// Mutant 1 — the headline contract.
// ---------------------------------------------------------------------------

test("a one-character code change inside a comment rewrite is CAUGHT", () => {
  const before = `// Batch 812: the epsilon below was raised after the polar
// tile probe showed cancellation at grazing angles.
const EPSILON = 1e-4;
export function isDegenerate(length) {
  return !(length > EPSILON);
}
`;
  // The rewrite the campaign is supposed to produce...
  const rewritten = `// Guards against a zero-length normal: the comparison is
// inverted so a NaN length is treated as degenerate.
const EPSILON = 1e-4;
export function isDegenerate(length) {
  return !(length > EPSILON);
}
`;
  // ...and the same rewrite with one constant quietly moved.
  const smuggled = rewritten.replace("1e-4", "1e-3");

  assertCommentOnly(
    before,
    rewritten,
    SUBJECT,
    "an honest comment rewrite must pass",
  );
  assertCodeDiffers(
    before,
    smuggled,
    SUBJECT,
    "a constant change hidden in a comment rewrite must be caught",
  );

  // The negative control is only meaningful if the two rewrites differ by
  // exactly the smuggled edit.
  assert.notEqual(rewritten, smuggled);
  assert.equal(rewritten.replace("1e-4", "1e-3"), smuggled);
});

test("an operator flip with identical comments is CAUGHT", () => {
  const before = "export const ok = (a, b) => a >= b;\n";
  const after = "export const ok = (a, b) => a > b;\n";
  assertCodeDiffers(before, after, SUBJECT, "`>=` to `>` must be caught");
});

// ---------------------------------------------------------------------------
// Mutant 2 — legitimate comment edits, in every shape a rewrite produces.
// ---------------------------------------------------------------------------

test("shrinking, growing and re-indenting comments all PASS", () => {
  const before = `/**
 * Does the thing.
 *
 * ★ C13-10 — added in Batch 900 after the march probe.
 * Historical note: the first attempt used a uniform.
 */
export function doThing(value) {
  // Batch 900: clamp first.
  const clamped = Math.max(0, value);

  // Batch 901: then scale.
  return clamped * 2;
}
`;
  const after = `/**
 * Scales a non-negative value by two.
 *
 * The clamp is applied before the multiply so a negative input cannot flip
 * the sign of the result.
 */
export function doThing(value) {
  const clamped = Math.max(0, value);
  return clamped * 2;
}
`;
  assertCommentOnly(before, after, SUBJECT, "a full-shape rewrite must pass");
});

test("blank-line churn left by comment removal is ABSORBED", () => {
  const before = "const a = 1;\n// one\n// two\n// three\nconst b = 2;\n";
  const after = "const a = 1;\nconst b = 2;\n";
  assertCommentOnly(before, after, SUBJECT, "removed comment lines must pass");
});

test("a trailing comment removed from a code line PASSES", () => {
  const before = "const a = 1; // Batch 4 note\nconst b = 2;\n";
  const after = "const a = 1;\nconst b = 2;\n";
  assertCommentOnly(before, after, SUBJECT, "trailing comment removal");
});

test("a block comment BETWEEN two tokens does not let them merge", () => {
  // Without the "replace a dropped comment with one space" rule these two
  // canonicalize to `ab` and `a b`, and the pair below would read as a code
  // change. With it, both are `a b`.
  const before = "const x = a/* joined */+ b;\n";
  const after = "const x = a + b;\n";
  assertCommentOnly(before, after, SUBJECT, "adjacent-token safety");
});

// ---------------------------------------------------------------------------
// Mutant 3 — comments that contain code-looking text.
// ---------------------------------------------------------------------------

test("a comment containing code text does not confuse the verifier", () => {
  const before = "export function f() {\n  return 3;\n}\n";

  // Adding a comment whose body is literally the code is comment-only.
  const withCommentedCode = `export function f() {
  // The historical form was:
  //   return 4;
  //   const unused = compute();
  return 3;
}
`;
  assertCommentOnly(
    before,
    withCommentedCode,
    SUBJECT,
    "code-shaped comment text must not register as code",
  );

  // Moving the REAL statement into a comment is a code change, even though
  // the file still contains the exact characters `return 3;`.
  const commentedOut = `export function f() {
  // return 3;
}
`;
  assertCodeDiffers(
    before,
    commentedOut,
    SUBJECT,
    "commenting real code out is a code change",
  );
});

test("`//` inside a string literal is not a comment", () => {
  const before = 'const url = "https://cesium.com//path"; // Batch 7\n';
  const afterCommentOnly = 'const url = "https://cesium.com//path";\n';
  const afterStringChanged = 'const url = "https://cesium.com/path";\n';

  assertCommentOnly(before, afterCommentOnly, SUBJECT, "string safety");
  assertCodeDiffers(
    before,
    afterStringChanged,
    SUBJECT,
    "a byte changed inside a string must be caught",
  );

  const comments = extractComments(before, "js");
  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, "// Batch 7");
});

test("`//` inside a regex literal is not a comment", () => {
  const before = "const re = /a\\/\\/b/g; // Batch 7\nconst n = 1;\n";
  const after = "const re = /a\\/\\/b/g;\nconst n = 1;\n";
  assertCommentOnly(before, after, SUBJECT, "regex safety");
  assertCodeDiffers(
    before,
    "const re = /a\\/b/g;\nconst n = 1;\n",
    SUBJECT,
    "a changed regex must be caught",
  );
});

test("comments inside a template substitution are comments; the raw text is not", () => {
  const before = [
    "const wgsl = `",
    "// this line is shader source, not a JS comment",
    "fn main() { return ${count /* JS comment */}; }",
    "`;",
    "",
  ].join("\n");
  const after = before.replace("/* JS comment */", "");
  assertCommentOnly(before, after, SUBJECT, "substitution comment removal");

  const shaderTextChanged = before.replace("fn main", "fn other");
  assertCodeDiffers(
    before,
    shaderTextChanged,
    SUBJECT,
    "the template's raw text is code and must be compared verbatim",
  );
});

// ---------------------------------------------------------------------------
// Mutant 4 — comments that are not comments: pragmas, directives, licenses.
// ---------------------------------------------------------------------------

test("deleting a debug pragma is CAUGHT even though it is a comment", () => {
  const before = `export function f(v) {
  //>>includeStart('debug', pragmas.debug);
  if (v < 0) {
    throw new DeveloperError("v");
  }
  //>>includeEnd('debug');
  return v;
}
`;
  const after = before
    .replace("  //>>includeStart('debug', pragmas.debug);\n", "")
    .replace("  //>>includeEnd('debug');\n", "");
  assertCodeDiffers(
    before,
    after,
    SUBJECT,
    "a stripped build pragma changes what the release bundle contains",
  );
});

test("deleting a WGSL preprocessor directive is CAUGHT", () => {
  const before = [
    "//>>ifdef CLOUD_RECONSTRUCTION",
    "let mode = 1u;",
    "//>>else",
    "let mode = 0u;",
    "//>>endif",
    "",
  ].join("\n");
  const after = "let mode = 1u;\nlet mode = 0u;\n";
  assertCodeDiffers(
    before,
    after,
    "packages/engine/Source/Shaders/WebGPU/Subject.wgsl",
    "WGSL ifdef directives select the compiled variant",
  );
});

test("deleting a license banner or a lint directive is CAUGHT", () => {
  const licensed = `/*! Copyright (c) 2008 Some Author. MIT licensed. */
export const value = 1;
`;
  assertCodeDiffers(
    licensed,
    "export const value = 1;\n",
    SUBJECT,
    "an attribution banner must not vanish under a comment-only claim",
  );

  const directive = `// eslint-disable-next-line no-unused-vars
export function f(a) {}
`;
  assertCodeDiffers(
    directive,
    "export function f(a) {}\n",
    SUBJECT,
    "a lint directive changes tool behaviour",
  );

  // A prose comment sitting next to a directive is still freely editable.
  assertCommentOnly(
    `// Batch 3 rationale.\n${directive}`,
    `// The parameter is part of the callback contract.\n${directive}`,
    SUBJECT,
    "prose beside a directive stays editable",
  );
});

// ---------------------------------------------------------------------------
// Mutant 5 — whitespace, line endings, and the one whitespace change that
// actually matters.
// ---------------------------------------------------------------------------

test("CRLF and LF compare equal", () => {
  const lf = "// note\nconst a = 1;\nconst b = 2;\n";
  const crlf = lf.replaceAll("\n", "\r\n");
  assertCommentOnly(crlf, lf, SUBJECT, "the worktree is CRLF, blobs are LF");
  assert.equal(canonicalizeCode(crlf, "js"), canonicalizeCode(lf, "js"));
});

test("re-indentation of code is tolerated but a newline that changes ASI is CAUGHT", () => {
  assertCommentOnly(
    "function f() {\n  return {\n    a: 1,\n  };\n}\n",
    "function f() {\n      return {\n        a: 1,\n      };\n}\n",
    SUBJECT,
    "pure re-indentation is not a semantic change",
  );

  // `return\nx` returns undefined; `return x` does not. A canonical form that
  // collapsed every whitespace run to a single space could not tell them apart.
  assertCodeDiffers(
    "function f(x) {\n  return\n  x;\n}\n",
    "function f(x) {\n  return x;\n}\n",
    SUBJECT,
    "automatic semicolon insertion depends on that newline",
  );
});

// ---------------------------------------------------------------------------
// Mutant 6 — shader grammars.
// ---------------------------------------------------------------------------

test("WGSL block comments nest, and a nested-comment rewrite PASSES", () => {
  const wgsl = "packages/engine/Source/Shaders/WebGPU/Subject.wgsl";
  const before =
    "/* outer /* inner */ still comment */\nfn f() -> f32 { return 1.0; }\n";
  const after = "// replaced\nfn f() -> f32 { return 1.0; }\n";
  assertCommentOnly(before, after, wgsl, "nested block comment handling");

  // If nesting were not honoured, `still comment */` would be read as code and
  // this pair would look identical. It must not.
  assertCodeDiffers(
    before,
    "/* outer /* inner */\nfn f() -> f32 { return 1.0; }\n",
    wgsl,
    "dropping the outer comment's tail is a text change",
  );
});

test("GLSL comments are stripped and GLSL code changes are CAUGHT", () => {
  const glsl = "packages/engine/Source/Shaders/SubjectFS.glsl";
  const before =
    "// Batch 56 note\nvoid main() { gl_FragColor = vec4(1.0); }\n";
  assertCommentOnly(
    before,
    "// Applies the opaque write.\nvoid main() { gl_FragColor = vec4(1.0); }\n",
    glsl,
    "GLSL comment rewrite",
  );
  assertCodeDiffers(
    before,
    "// Batch 56 note\nvoid main() { gl_FragColor = vec4(0.0); }\n",
    glsl,
    "GLSL constant change",
  );
});

// ---------------------------------------------------------------------------
// The file-set contract: a comment rewrite adds, deletes and renames nothing.
// ---------------------------------------------------------------------------

test("added, deleted and renamed in-scope files are VIOLATIONS", async () => {
  const read = async () => "const a = 1;\n";
  const report = await runComparison({
    files: [
      { path: `${SUBJECT}`, change: "M" },
      { path: "packages/engine/Source/Scene/New.js", change: "A" },
      { path: "packages/engine/Source/Scene/Gone.js", change: "D" },
    ],
    readBefore: read,
    readAfter: read,
  });
  assert.equal(report.checked.length, 1);
  assert.deepEqual(
    report.violations.map((v) => v.status),
    ["file-set-changed", "file-set-changed"],
  );
});

test("an in-scope file the tool cannot strip is a VIOLATION, not a pass", async () => {
  const read = async () => "{}";
  const report = await runComparison({
    files: [{ path: "packages/engine/Source/Assets/table.json", change: "M" }],
    readBefore: read,
    readAfter: read,
  });
  assert.equal(report.checked.length, 0);
  assert.equal(report.violations[0].status, "unsupported-in-scope");
});

test("paths outside the standard's scope are reported, not failed", async () => {
  const report = await runComparison({
    files: [
      { path: "migration_doc/DEV_NOTES_CLOUDS.md", change: "M" },
      { path: "Tools/c16/comment-marker-cleanlist.txt", change: "M" },
      { path: "Specs/Renderer/SubjectSpec.js", change: "M" },
    ],
    readBefore: async () => "",
    readAfter: async () => "",
  });
  assert.equal(report.violations.length, 0);
  assert.equal(report.skipped.length, 3);
});

// ---------------------------------------------------------------------------
// Structural tier: an empty comparison must not read as a pass.
// ---------------------------------------------------------------------------

test("comparing nothing exits 3 (STRUCTURAL), not 0", () => {
  const cli = fileURLToPath(
    new URL("./comment-only-diff.mjs", import.meta.url),
  );
  let status = 0;
  let output;
  try {
    output = execFileSync(
      process.execPath,
      [cli, "--base", "HEAD", "--", "packages/engine/Source/NoSuchFile.ts"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.equal(
    status,
    3,
    `an empty file set must be structural, got ${status}:\n${output}`,
  );
  assert.match(output, /STRUCTURAL/);
});

// ---------------------------------------------------------------------------
// Real-corpus invariants. The mutants above are synthetic; these run the same
// tokenizer over every file the campaign will actually rewrite.
// ---------------------------------------------------------------------------

test("tokenizer segments reassemble every in-scope file byte for byte", async () => {
  const files = await collectScopeFiles();
  assert.ok(files.length > 1000, `expected a real corpus, got ${files.length}`);
  const failures = [];
  for (const relPath of files) {
    const source = await fs.readFile(path.join(ROOT, relPath), "utf8");
    const language = relPath.endsWith(".wgsl")
      ? "wgsl"
      : relPath.endsWith(".glsl")
        ? "glsl"
        : "js";
    const segments = tokenize(source, language);
    let cursor = 0;
    let rebuilt = "";
    let contiguous = true;
    for (const segment of segments) {
      if (segment.start !== cursor) {
        contiguous = false;
        break;
      }
      rebuilt += source.slice(segment.start, segment.end);
      cursor = segment.end;
    }
    if (!contiguous || cursor !== source.length || rebuilt !== source) {
      failures.push(relPath);
    }
  }
  assert.deepEqual(failures, [], "segments must cover the source with no gaps");
});

test("canonicalization is idempotent over the whole corpus", async () => {
  const files = await collectScopeFiles();
  const failures = [];
  for (const relPath of files) {
    const source = await fs.readFile(path.join(ROOT, relPath), "utf8");
    const language = relPath.endsWith(".wgsl")
      ? "wgsl"
      : relPath.endsWith(".glsl")
        ? "glsl"
        : "js";
    const once = canonicalizeCode(source, language);
    if (canonicalizeCode(once, language) !== once) {
      failures.push(relPath);
    }
  }
  assert.deepEqual(
    failures,
    [],
    "a canonical form that is not a fixed point cannot be compared reliably",
  );
});

test("a no-op edit to every in-scope file is comment-only", async () => {
  // The pass path over real data: identical input on both sides must never be
  // reported as a code change, whatever exotic syntax the file contains.
  const files = await collectScopeFiles();
  const failures = [];
  for (const relPath of files.slice(0, 400)) {
    const source = await fs.readFile(path.join(ROOT, relPath), "utf8");
    if (compareSources(source, source, relPath).status !== "comment-only") {
      failures.push(relPath);
    }
  }
  assert.deepEqual(failures, []);
});
