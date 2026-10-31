// wgsl-compute-codegen.spec.mjs — pins lib/wgsl-compute-codegen.mjs: the f32
// rounding and u32/i32 wrapping it emits (observed by running a kernel), the
// generator split for barrier-reaching functions, and that every construct
// outside its type rules throws (with inertness mutants on both).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseComputeModule } from "./lib/wgsl-compute-parser.mjs";
import { generateComputeModule } from "./lib/wgsl-compute-codegen.mjs";
import { compileComputeModule } from "./lib/wgsl-compute-exec.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEGEN = path.join(HERE, "lib/wgsl-compute-codegen.mjs");
const EXEC = path.join(HERE, "lib/wgsl-compute-exec.mjs");

const generate = (source, codegen = generateComputeModule) =>
  codegen(parseComputeModule(source));

// One invocation writes four results into a 1x1 rgba32float texture.
const ARITHMETIC = `
@group(0) @binding(0) var Out: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(1, 1, 1)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let a = (0.1f + 0.2f) - 0.3f;
  let wrapped = 4294967295u + 2u;
  let product = 65537u * 65537u;
  let negative = i32(lid.x) - 2147483647i - 2i;
  textureStore(Out, vec2<i32>(0, 0), vec4<f32>(a, f32(wrapped), f32(product), f32(negative)));
}
`;

function runArithmetic(exec) {
  const out = {
    width: 1,
    height: 1,
    format: "rgba32float",
    data: new Float32Array(4),
  };
  exec.compileComputeModule(ARITHMETIC).dispatch("main", { 0: out }, [1]);
  return Array.from(out.data);
}

function checkArithmetic(exec) {
  const [a, wrapped, product, negative] = runArithmetic(exec);
  const f = Math.fround;
  // (0.1 + 0.2) - 0.3 is 0 when the sum is rounded to f32 before the
  // subtraction and -7.45e-9 when it is not; the texture store alone would
  // hide the difference, so the residual is what is stored.
  assert.equal(
    a,
    f(f(f(0.1) + f(0.2)) - f(0.3)),
    "every f32 operation rounds, not only the final store",
  );
  assert.notEqual(f(f(0.1) + f(0.2) - f(0.3)), a, "the case can tell");
  assert.equal(wrapped, 1, "u32 addition wraps");
  assert.equal(product, f((65537 * 65537) % 2 ** 32), "u32 multiply wraps");
  assert.equal(negative, f(2147483647), "i32 subtraction wraps to +2^31-1");
}

test("emitted arithmetic rounds f32 and wraps u32 / i32", () => {
  checkArithmetic({ compileComputeModule });
});

test("MUTANT: an f32 operator emitted without F goes red", async () => {
  // The code generator has no imports, so its mutated text loads as a data:
  // URL; the runtime is then loaded with its codegen import pointed at it.
  const source = fs.readFileSync(CODEGEN, "utf8").replace(/\r\n/g, "\n");
  const anchor = "      return `F(${a} ${op} ${b})`;";
  assert.equal(source.split(anchor).length, 2, "anchor occurs once");
  const mutatedUrl = `data:text/javascript;base64,${Buffer.from(
    source.replace(anchor, () => "      return `(${a} ${op} ${b})`;"),
  ).toString("base64")}`;
  const exec = await importMutated(EXEC, [
    [`"${pathToFileURL(CODEGEN).href}"`, `"${mutatedUrl}"`],
  ]);
  assert.throws(() => checkArithmetic(exec), assert.AssertionError);
});

test("functions that reach a barrier become generators; others stay plain", () => {
  const { javascript } = generate(`
var<workgroup> s: array<f32, 4>;
fn plain(x: f32) -> f32 { return x * 2.0; }
fn sync() { workgroupBarrier(); }
fn outer() { sync(); }
@compute @workgroup_size(4, 1, 1)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) { s[lid.x] = plain(1.0); outer(); }
`);
  assert.match(javascript, /function f_plain\(/);
  assert.match(javascript, /function\* f_sync\(/);
  assert.match(javascript, /function\* f_outer\(/, "transitively");
  assert.match(javascript, /function\* f_main\(/);
});

const REJECTED = [
  [
    "component assignment",
    "fn f() { var v = vec2<f32>(1.0, 2.0); v.x = 3.0; }",
    /component assignment/,
  ],
  ["unknown identifier", "fn f() -> f32 { return q; }", /unknown identifier q/],
  [
    "unsupported builtin",
    "fn f() -> f32 { return exp(1.0); }",
    /unsupported call exp/,
  ],
  [
    "u32 + i32",
    "fn f(a: u32, b: i32) -> u32 { return a + b; }",
    /type mismatch/,
  ],
  ["non-bool condition", "fn f(a: u32) { if (a) { } }", /must be bool/],
  ["matrix type", "var<workgroup> m: array<mat4x4<f32>, 2>;", /workgroup type/],
  [
    "storage buffer",
    "@group(0) @binding(0) var<storage, read_write> b: array<f32>;",
    /unsupported module var/,
  ],
  [
    "bind group 1",
    "@group(1) @binding(0) var t: texture_2d<f32>;",
    /only bind group 0/,
  ],
  [
    "an entry parameter other than an invocation id",
    "@compute @workgroup_size(1) fn main(@builtin(workgroup_index) i: u32) { }",
    /entry parameter/,
  ],
];

function checkRejections(codegen) {
  for (const [name, source, message] of REJECTED) {
    assert.throws(() => generate(source, codegen), message, name);
  }
}

test("constructs outside the type rules throw at generation time", () => {
  checkRejections(generateComputeModule);
});

test("MUTANT: with the component-assignment refusal removed, the check goes red", async () => {
  const mutated = await importMutated(CODEGEN, [
    [
      'throw new Error("wgsl-compute-codegen: component assignment");',
      'return "";',
    ],
  ]);
  assert.throws(
    () => checkRejections(mutated.generateComputeModule),
    assert.AssertionError,
  );
});
