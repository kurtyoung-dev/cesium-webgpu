import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ShaderFunction from "../../Source/Renderer/ShaderFunction.js";
import ShaderStruct from "../../Source/Renderer/ShaderStruct.js";

// THE BEHAVIOUR THIS PINS, STATED WITHOUT REFERENCE TO ANY IMPLEMENTATION.
//
//   1. `generateGlslLines()` returns the struct's or function's lines and
//      NOTHING after the closing brace — for empty and populated bodies
//      alike. A line array whose last element is the empty string puts a
//      blank line into every generated shader, because `ShaderBuilder`
//      joins these arrays with "\n" before handing them to `ShaderSource`.
//   2. A function with an EMPTY body still generates `signature { }` and
//      does not throw. `MetadataPipelineStage` registers
//      `initializeMetadata` / `setMetadataVaryings` unconditionally, and
//      every model without metadata reaches that path; a throw here stops
//      rendering. That behaviour is load-bearing and is asserted here so a
//      future "add a guard" edit fails loudly instead of at render time.
//   3. `addLines()` called with no argument, or with a non-string
//      non-array, raises `DeveloperError` and adds NOTHING to the body —
//      in particular it never appends the GLSL line `"    undefined"`.
//      Asserting the absence of the bad line is the point: a spec that
//      only asserts "something threw" passes against a guard that throws
//      after already corrupting the body.
//
// WHY THIS FILE IS `.mjs` AND NOT A KARMA SPEC. The karma suite already
// owns `ShaderStructSpec.js`, `ShaderFunctionSpec.js` and
// `ShaderBuilderSpec.js` — all three byte-identical to upstream's — and
// they are the end-to-end acceptance. They need a build and a browser.
// These two classes are pure string builders with no GPU surface and no
// build-generated import, so their contract is provable in bare Node in
// milliseconds, which is what keeps it checkable on a lane that cannot run
// karma. The karma glob is `packages/engine/Specs/**/*Spec.js`
// (`gulpfile.js`), so an `.mjs` here is NOT collected twice.
//
// WHY `ShaderBuilder` ITSELF IS NOT IMPORTED. It reaches `ShaderSource.js`,
// which imports the build-generated `Source/Shaders/Builtin/CzmBuiltins.js`;
// that file does not exist in an unbuilt checkout, so importing it here
// would make the spec depend on a build. Section B therefore performs the
// join `ShaderBuilder.buildShaderProgram` performs over line arrays that
// come from the real generators, and says so; the browser end of that seam
// is `ShaderBuilderSpec.js`.
//
// SECTION C builds mutants in a temp directory and asserts that the very
// assertions Sections A and B make go RED against them — the inertness
// proof travels with the spec instead of living only in a packet.
//
// Run: node --test packages/engine/Specs/Renderer/ShaderGeneratorUpstreamContractSpec.mjs

const RENDERER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../Source/Renderer",
);

// ─── the contracts, as functions, so Section C can run them against a mutant ───

function assertStructContract(Struct) {
  const populated = new Struct("TestStruct");
  populated.addField("vec3", "positionMC");
  populated.addField("float", "weights[4]");
  populated.addField("OtherStruct", "complex");
  assert.deepEqual(populated.generateGlslLines(), [
    "struct TestStruct",
    "{",
    "    vec3 positionMC;",
    "    float weights[4];",
    "    OtherStruct complex;",
    "};",
  ]);

  // GLSL ES 3.00 forbids an empty struct body, so an unpopulated struct
  // carries one filler field — and still stops at the closing brace.
  const empty = new Struct("Nothing");
  assert.deepEqual(empty.generateGlslLines(), [
    "struct Nothing",
    "{",
    "    float _empty;",
    "};",
  ]);

  for (const lines of [
    populated.generateGlslLines(),
    empty.generateGlslLines(),
  ]) {
    assert.equal(lines[lines.length - 1], "};");
  }
}

function assertFunctionContract(Func) {
  const populated = new Func("vec3 testFunction(vec3 position)");
  populated.addLines(["v_color = a_color;", "return vec3(0.0, 0.0, 1.0);"]);
  assert.deepEqual(populated.generateGlslLines(), [
    "vec3 testFunction(vec3 position)",
    "{",
    "    v_color = a_color;",
    "    return vec3(0.0, 0.0, 1.0);",
    "}",
  ]);

  // An empty body is legal GLSL and is reached by every metadata-free
  // model. It generates, it does not throw, and it stops at the brace.
  const empty = new Func("void noop()");
  assert.deepEqual(empty.generateGlslLines(), ["void noop()", "{", "}"]);

  for (const lines of [
    populated.generateGlslLines(),
    empty.generateGlslLines(),
  ]) {
    assert.equal(lines[lines.length - 1], "}");
  }
}

function assertValidationContract(Func) {
  for (const bad of [undefined, null, 100, {}, true]) {
    const func = new Func("void f()");
    assert.throws(
      () => func.addLines(bad),
      (error) =>
        error.name === "DeveloperError" &&
        error.message ===
          `Expected lines to be a string or an array of strings, actual value was ${bad}`,
      `addLines(${String(bad)}) must raise DeveloperError`,
    );
    // The body is what ends up in the shader. A guard that throws after
    // pushing has not protected anything.
    assert.deepEqual(func.body, []);
    assert.equal(func.generateGlslLines().includes("    undefined"), false);
  }

  // The two accepted shapes are unchanged.
  const single = new Func("void f()");
  single.addLines("v_color = a_color;");
  assert.deepEqual(single.body, ["    v_color = a_color;"]);

  const array = new Func("void f()");
  array.addLines(["a;", "b;"]);
  assert.deepEqual(array.body, ["    a;", "    b;"]);
}

// The join `ShaderBuilder.buildShaderProgram` performs before handing the
// text to `ShaderSource`: one string, so `ShaderSource` emits a single
// `#line 0` rather than one per line.
function assembleShaderSource(blocks) {
  return blocks.flat().join("\n");
}

function assertAssemblyContract(Struct, Func) {
  const struct = new Struct("TestStruct");
  struct.addField("vec3", "positionMC");
  const func = new Func("vec3 testFunction(vec3 position)");
  func.addLines("return position;");

  const source = assembleShaderSource([
    struct.generateGlslLines(),
    func.generateGlslLines(),
  ]);

  assert.equal(
    source,
    [
      "struct TestStruct",
      "{",
      "    vec3 positionMC;",
      "};",
      "vec3 testFunction(vec3 position)",
      "{",
      "    return position;",
      "}",
    ].join("\n"),
  );
  assert.equal(
    /\n\n/u.test(source),
    false,
    "the assembled GLSL must carry no blank line",
  );
}

// ─── Section A — the two generators, against the real modules ───

test("A1 a struct generates its own lines and nothing after the closing brace", () => {
  assertStructContract(ShaderStruct);
});

test("A2 a function generates its own lines and nothing after the closing brace", () => {
  assertFunctionContract(ShaderFunction);
});

test("A3 addLines rejects a non-string non-array and leaves the body empty", () => {
  assertValidationContract(ShaderFunction);
});

// ─── Section B — the text those line arrays assemble into ───

test("B1 a struct and a function assemble into GLSL with no blank line between them", () => {
  assertAssemblyContract(ShaderStruct, ShaderFunction);
});

// ─── Section C — inertness mutants ───
//
// Each mutant is a copy of the real module under the OS temp directory,
// never inside this repository, rewritten by an ANCHORED replacement that
// fails loudly when its anchor has moved — so a mutant can never pass
// vacuously by rewriting nothing.

function mutate(source, from, to, label) {
  assert.ok(
    source.includes(from),
    `the ${label} mutation anchor has moved — re-derive it from the source`,
  );
  const mutated = source.replace(from, to);
  assert.notEqual(mutated, source, `the ${label} mutation changed nothing`);
  return mutated;
}

async function withMutant(fileName, rewrite, body, transformRaw) {
  const dir = await mkdtemp(path.join(tmpdir(), "cesium-shadergen-mutant-"));
  assert.equal(
    path.relative(tmpdir(), dir).startsWith(".."),
    false,
    "the mutant sandbox must live under the OS temp directory",
  );
  try {
    // A Windows checkout of this repository is CRLF (`core.autocrlf=true`
    // against `.gitattributes`' `* text=auto`), so an anchor written with
    // "\n" matches nothing on disk and every Section C test fails on the
    // anchor guard instead of on the mutant. Mutant identity belongs to the
    // source text, not to the checkout's line endings. C4 pushes the CRLF
    // form back through this same read, so deleting the normalisation
    // reddens a test on an LF checkout too.
    const raw = readFileSync(path.join(RENDERER_DIR, fileName), "utf8");
    const original = (transformRaw ? transformRaw(raw) : raw).replace(
      /\r\n/gu,
      "\n",
    );
    // The copy leaves the Renderer directory, so its one relative import
    // is repointed at the real module by absolute URL.
    const rewritten = rewrite(original).replace(
      '"../Core/DeveloperError.js"',
      JSON.stringify(
        pathToFileURL(
          path.join(RENDERER_DIR, "..", "Core", "DeveloperError.js"),
        ).href,
      ),
    );
    const target = path.join(dir, fileName);
    await writeFile(target, rewritten, "utf8");
    const mutant = (await import(pathToFileURL(target).href)).default;
    await body(mutant);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// C1/C2 and C4 apply the SAME two rewrites; naming them keeps one definition
// of each anchor pair rather than two copies that can drift apart.
const restoreStructTrailingLine = (source) =>
  mutate(
    source,
    'lines.push("};");\n    return lines;',
    'lines.push("};");\n    lines.push("");\n    return lines;',
    "struct trailing-line",
  );

const restoreFunctionTrailingLine = (source) =>
  mutate(
    source,
    'lines.push("}");\n    return lines;',
    'lines.push("}");\n    lines.push("");\n    return lines;',
    "function trailing-line",
  );

function assertStructTrailingLineIsRed(Mutant) {
  assert.throws(() => assertStructContract(Mutant), {
    name: "AssertionError",
  });
  assert.throws(() => assertAssemblyContract(Mutant, ShaderFunction), {
    name: "AssertionError",
  });
}

function assertFunctionTrailingLineIsRed(Mutant) {
  assert.throws(() => assertFunctionContract(Mutant), {
    name: "AssertionError",
  });
  assert.throws(() => assertAssemblyContract(ShaderStruct, Mutant), {
    name: "AssertionError",
  });
}

test("C1 restoring the struct's trailing empty line turns A1 and B1 red", async () => {
  await withMutant(
    "ShaderStruct.js",
    restoreStructTrailingLine,
    assertStructTrailingLineIsRed,
  );
});

test("C2 restoring the function's trailing empty line turns A2 and B1 red", async () => {
  await withMutant(
    "ShaderFunction.js",
    restoreFunctionTrailingLine,
    assertFunctionTrailingLineIsRed,
  );
});

test("C3 making the addLines guard unreachable turns A3 red", async () => {
  await withMutant(
    "ShaderFunction.js",
    (source) =>
      mutate(
        source,
        'if (typeof lines !== "string" && !Array.isArray(lines)) {',
        'if (false && typeof lines !== "string" && !Array.isArray(lines)) {',
        "addLines guard",
      ),
    (Mutant) => {
      assert.throws(() => assertValidationContract(Mutant), {
        name: "AssertionError",
      });
      // and the corruption the guard exists to stop is back
      const func = new Mutant("void f()");
      func.addLines();
      assert.deepEqual(func.body, ["    undefined"]);
    },
  );
});

// C4 is the inertness mutant for `withMutant`'s own EOL normalisation. This
// repository checks out CRLF on Windows, so on such a tree C1 and C2 fail on
// their anchor guard rather than on the mutant, and the whole of Section C
// stops proving anything — measured, before the normalisation existed, at
// 7 tests / 5 pass / 2 fail. A checkout that happens to hold LF cannot see
// that, so C4 forces the CRLF form through the same read path on every tree:
// remove the normalisation and C4 goes red wherever it runs.
function toCrlfFixture(raw) {
  const crlf = raw.replace(/\r\n/gu, "\n").replace(/\n/gu, "\r\n");
  assert.ok(crlf.includes("\r\n"), "the CRLF fixture must carry CRLF");
  assert.equal(
    /[^\r]\n/u.test(crlf),
    false,
    "the CRLF fixture must carry no bare LF",
  );
  assert.notEqual(crlf, raw.replace(/\r\n/gu, "\n"), "the fixture must differ");
  return crlf;
}

test("C4 the Section C mutations still apply against a CRLF checkout", async () => {
  await withMutant(
    "ShaderStruct.js",
    restoreStructTrailingLine,
    assertStructTrailingLineIsRed,
    toCrlfFixture,
  );
  await withMutant(
    "ShaderFunction.js",
    restoreFunctionTrailingLine,
    assertFunctionTrailingLineIsRed,
    toCrlfFixture,
  );
});
