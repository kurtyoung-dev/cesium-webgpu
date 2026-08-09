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
  SEMANTIC_COMMENT_RULES,
  canonicalizeCode,
  classifySemanticComment,
  extractComments,
  selfTestSemanticRules,
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
// Mutant 4b — the OTHER direction of the same rule. Retaining a directive
// protects it, and protection is immobility: a comment the canonical form
// keeps cannot be reworded without the gate calling it a code change. So the
// rule that decides "this is a directive" has two failure modes, not one, and
// the tests below pin both. Under-matching drops a real pragma; over-matching
// freezes a sentence, and a frozen sentence is an obstacle handed to the very
// rewrite this gate is supposed to be checking.
// ---------------------------------------------------------------------------

/**
 * Wrap a comment in a trivial file, and the same file with the comment gone.
 *
 * @param {string} comment Comment text, delimiters included.
 * @returns {{withComment: string, without: string}} The pair.
 */
function fileAround(comment) {
  return {
    withComment: `${comment}\nexport const value = 1;\n`,
    without: "export const value = 1;\n",
  };
}

test("the semantic-comment rule table passes its own negative control", () => {
  assert.deepEqual(
    selfTestSemanticRules(),
    [],
    "a rule that stopped matching its own directive would unprotect it silently",
  );
  assert.ok(
    SEMANTIC_COMMENT_RULES.length > 5,
    "an emptied rule table would pass every test above by protecting nothing",
  );
  // Each rule must carry a real example, or its self-test proves nothing.
  for (const rule of SEMANTIC_COMMENT_RULES) {
    assert.ok(
      rule.examples.length > 0,
      `${rule.id} declares no directive example`,
    );
  }
});

test("every directive shape in the tree is STILL protected end to end", () => {
  // Table-driven over the real rule set rather than a hand-picked sample: a
  // rule added later without a directive example fails the test above, and one
  // added with an example it cannot actually protect fails here.
  for (const rule of SEMANTIC_COMMENT_RULES) {
    for (const example of rule.examples) {
      const { withComment, without } = fileAround(example);
      assertCodeDiffers(
        withComment,
        without,
        SUBJECT,
        `deleting ${JSON.stringify(example)} must be caught (rule ${rule.id})`,
      );
    }
  }
});

test("prose that merely begins with a directive word is EDITABLE", () => {
  for (const rule of SEMANTIC_COMMENT_RULES) {
    for (const counter of rule.counterExamples) {
      assert.equal(
        classifySemanticComment(counter),
        null,
        `${JSON.stringify(counter)} is prose, not a ${rule.id} directive`,
      );
      const { withComment } = fileAround(counter);
      assertCommentOnly(
        withComment,
        fileAround("// Rewritten during the shard.").withComment,
        SUBJECT,
        `prose beginning with a ${rule.id} word must stay rewritable`,
      );
    }
  }
});

test("a sentence wrapped onto a line beginning `global` is EDITABLE", () => {
  // Verbatim from `Scene/Weather/WeatherTexPacker.ts`. The rewrite shard that
  // covered that file left this line alone — not by choice: the gate read
  // "global field this is the identity" as an ESLint globals declaration and
  // reported any rewording of it as a code change.
  const before = `    // Then place that texel inside the field's own window. For a
    // global field this is the identity, so the expression below is still the
    // plain \`((ty + 0.5) / texH) * (gh - 1)\`.
    const fv = weatherFieldV(texelV, bounds);
`;
  const after = `    // Places the texel inside the field's own window. A global field makes
    // that window the whole texture, so the expression reduces to the plain
    // \`((ty + 0.5) / texH) * (gh - 1)\`.
    const fv = weatherFieldV(texelV, bounds);
`;
  assertCommentOnly(
    before,
    after,
    "packages/engine/Source/Scene/Weather/WeatherTexPacker.ts",
    "a wrapped sentence is not an ESLint globals declaration",
  );

  // The declaration ESLint actually reads is the block form, and it is still
  // protected. This pair is the whole rule in two lines: same leading word,
  // opposite verdicts, and nothing but the comment's shape separates them.
  assertCodeDiffers(
    "/* global CESIUM_BASE_URL */\nexport const value = 1;\n",
    "export const value = 1;\n",
    SUBJECT,
    "`/* global ... */` declares a global to ESLint and must not vanish",
  );
});

test("a sentence wrapped onto a line beginning `!` is EDITABLE", () => {
  // Verbatim from `Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`: a boolean
  // expression quoted across a line break, whose continuation line opens on
  // the negation operator. `/^!/` was meant for the `/*!` banner convention,
  // which is a property of the opening delimiter — so applied per `//` line it
  // matched only prose, in every occurrence in this repository.
  const before = `      // WebGL truncates the draw count to \`mesh.indexCountWithoutSkirts\`
      // when \`showSkirts = tileProvider.showSkirts && !cameraUnderground &&
      // !translucent\` is false, because skirt indices sit at the tail of the
      // index buffer.
      drawSkirts(command);
`;
  const after = `      // Skirt indices sit at the tail of the index buffer, so WebGL drops the
      // skirt walls by truncating the draw count rather than by culling.
      drawSkirts(command);
`;
  assertCommentOnly(
    before,
    after,
    SUBJECT,
    "a negated expression quoted in prose is not a license banner",
  );

  // GLSL and WGSL reach the same predicate through a different tokenizer, and
  // the shader trees hold their own share of these lines.
  assertCommentOnly(
    "// !gl_FrontFacing misbehaves on some drivers.\nbool f() { return true; }\n",
    "// Some drivers evaluate the negation inconsistently.\nbool f() { return true; }\n",
    "packages/engine/Source/Shaders/SubjectFS.glsl",
    "the shader grammars share the predicate",
  );

  // The banner the rule is actually for is still caught.
  assertCodeDiffers(
    "/*! Copyright (c) 2008 Some Author. MIT licensed. */\nexport const value = 1;\n",
    "export const value = 1;\n",
    SUBJECT,
    "`/*!` is the banner convention and must survive",
  );
});

test("prose beginning `eslint` is EDITABLE; the directive is not", () => {
  const prose =
    "// eslint has no WGSL grammar, so the guard is a Node script instead.\n";
  assertCommentOnly(
    `${prose}export const value = 1;\n`,
    "// The guard is a Node script; no linter covers WGSL.\nexport const value = 1;\n",
    SUBJECT,
    "naming the linter is not configuring it",
  );

  // ESLint honours `// eslint-disable-next-line` in line form, so — unlike
  // `global` — the line shape cannot be the discriminator here. The closed
  // directive vocabulary is.
  assertCodeDiffers(
    "// eslint-disable-next-line no-console\nconsole.log(1);\n",
    "console.log(1);\n",
    SUBJECT,
    "a line-form eslint-disable really does change what the linter reports",
  );
});

test("MUTATION: without the shape rule, the wrapped `global` line refreezes", async () => {
  // The tests above show the prose is editable. They do not show WHY, and a
  // predicate that had simply stopped protecting everything would pass them
  // all. Remove the shape check from a copy of the scanner and require the
  // misclassification to come back.
  const scannerPath = fileURLToPath(
    new URL("./lib/comment-scanner.mjs", import.meta.url),
  );
  // The working tree is CRLF and the anchors below are written LF, so fold the
  // terminators before matching. Nothing else about the source is touched.
  const original = (await fs.readFile(scannerPath, "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const guard = `if (rule.shape !== "any" && rule.shape !== shape) {
      continue;
    }`;
  assert.ok(
    original.includes(guard),
    "the shape guard moved; this mutation no longer tests anything",
  );
  const mutated = original.replace(guard, "");
  assert.notEqual(mutated, original);

  // The module imports nothing, so a data URL is enough to load the mutant
  // without writing a second copy into the tree.
  const mutant = await import(
    `data:text/javascript;base64,${Buffer.from(mutated, "utf8").toString("base64")}`
  );

  const proseLine = "// global barrier pass.";
  assert.equal(
    classifySemanticComment(proseLine),
    null,
    "control: the real scanner treats this as prose",
  );
  assert.equal(
    mutant.classifySemanticComment(proseLine),
    "eslint-globals",
    "the shape check is what releases the wrapped sentence",
  );
  assert.equal(
    mutant.classifySemanticComment("/* global CESIUM_BASE_URL */"),
    "eslint-globals",
    "the mutant still protects the real directive — only the shape test is gone",
  );
});

test("MUTATION: without the delimiter rule, the wrapped `!` line refreezes", async () => {
  const scannerPath = fileURLToPath(
    new URL("./lib/comment-scanner.mjs", import.meta.url),
  );
  const original = (await fs.readFile(scannerPath, "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const bannerRule = `    shape: "block",
    raw: /^\\/\\*+!/,`;
  assert.ok(
    original.includes(bannerRule),
    "the banner rule moved; this mutation no longer tests anything",
  );
  const mutated = original.replace(
    bannerRule,
    `    shape: "any",
    body: /^!/,`,
  );
  assert.notEqual(mutated, original);

  const mutant = await import(
    `data:text/javascript;base64,${Buffer.from(mutated, "utf8").toString("base64")}`
  );

  const proseLine = "// !exitFromInside && !enterFromOutside";
  assert.equal(
    classifySemanticComment(proseLine),
    null,
    "control: the real scanner treats this as prose",
  );
  assert.equal(
    mutant.classifySemanticComment(proseLine),
    "license-banner",
    "reading `!` from the body rather than the delimiter is what froze it",
  );
});

test("no in-scope comment is classified semantic by prose alone", async () => {
  // The real-corpus form of the same claim. Anything the canonical form keeps
  // is a comment no rewrite shard may touch, so the set had better contain
  // only genuine directives — and the cheapest way to be wrong is to hold a
  // line comment whose leading word is ordinary English.
  const files = await collectScopeFiles();
  const frozenProse = [];
  for (const relPath of files) {
    const source = await fs.readFile(path.join(ROOT, relPath), "utf8");
    const language = relPath.endsWith(".wgsl")
      ? "wgsl"
      : relPath.endsWith(".glsl")
        ? "glsl"
        : "js";
    for (const comment of extractComments(source, language)) {
      if (!comment.semantic || comment.block) {
        continue;
      }
      const body = comment.text.replace(/^\/\/\s*/, "");
      // Every line-form directive in this tree starts with one of these. A
      // line comment held for any other reason is prose that got frozen.
      if (
        !/^(>>|eslint-(disable|enable|env)\b|@ts-(check|nocheck|ignore|expect-error)\b|prettier-ignore|(istanbul|c8|v8)\s+ignore\b)/.test(
          body,
        )
      ) {
        frozenProse.push(`${relPath}:${comment.line}  ${comment.text.trim()}`);
      }
    }
  }
  assert.deepEqual(
    frozenProse,
    [],
    "these comments are un-editable under the gate for no reason a tool honours",
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

test("CRLF inside a multi-line literal compares equal, other bytes do not", () => {
  // Whitespace collapsing reaches only the code between literals, and literals
  // are compared verbatim — so without a whole-input line-terminator fold, any
  // file holding an embedded shader string fails on line endings alone. Several
  // do, `WebGPUGaussianSplatRenderer.ts` among them, and the failure names a
  // "code change" at a line nobody touched.
  const lf = "const WGSL = `\n@compute\nfn main() {}\n`;\n";
  const crlf = lf.replaceAll("\n", "\r\n");
  assertCommentOnly(
    crlf,
    lf,
    SUBJECT,
    "a CRLF worktree must not read as a code change inside an embedded shader",
  );

  // The fold must not become a licence to edit the literal.
  assertCodeDiffers(
    lf,
    lf.replace("fn main() {}", "fn main() { x(); }"),
    SUBJECT,
    "a real change inside an embedded shader is still a code change",
  );
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
