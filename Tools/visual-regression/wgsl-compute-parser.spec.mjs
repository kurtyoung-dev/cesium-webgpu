// wgsl-compute-parser.spec.mjs — pins lib/wgsl-compute-parser.mjs: the tree it
// builds for the supported compute subset, and that every construct outside the
// subset throws with a message naming it (with an inertness mutant).

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseComputeModule } from "./lib/wgsl-compute-parser.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARSER = path.join(HERE, "lib/wgsl-compute-parser.mjs");

const MODULE = `
struct Params { step: u32, scale: f32, };
@group(0) @binding(0) var Out: texture_storage_2d<rg32float, write>;
@group(0) @binding(1) var<uniform> params: Params;
const K: u32 = 4u; /* block comment */
var<workgroup> s: array<vec4<f32>, 256>;
fn helper(a: vec2<f32>) -> vec2<f32> { return a * 2.0; }
@compute @workgroup_size(256, 1, 1)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  var acc = 0u;
  for (var i: u32 = 0u; i < K; i = i + 1u) {
    if (i == 2u) { acc = acc + 1u; } else if (i > 2u) { acc = acc << 1u; } else { acc = acc | 1u; }
  }
  s[lid.x] = vec4<f32>(helper(vec2<f32>(1.0, -2.0)), 0.0, f32(acc));
  workgroupBarrier();
}
`;

test("the supported subset parses into the declaration tree", () => {
  const decls = parseComputeModule(MODULE);
  assert.deepEqual(
    decls.map((d) => `${d.kind}:${d.name}`),
    [
      "struct:Params",
      "var:Out",
      "var:params",
      "const:K",
      "var:s",
      "fn:helper",
      "fn:main",
    ],
  );
  const [params, out, uniform, k, s, helper, main] = decls;
  assert.deepEqual(
    params.members.map((m) => `${m.name}:${m.type}`),
    ["step:u32", "scale:f32"],
  );
  assert.equal(out.type, "texture_storage_2d<rg32float,write>");
  assert.deepEqual(out.attrs, { group: ["0"], binding: ["0"] });
  assert.equal(uniform.space, "uniform");
  assert.equal(k.type, "u32");
  assert.equal(s.space, "workgroup");
  assert.equal(s.type, "array<vec4<f32>,256>");
  assert.equal(helper.ret, "vec2<f32>");
  assert.deepEqual(main.attrs.workgroup_size, ["256", "1", "1"]);
  assert.deepEqual(main.params[0].attrs.builtin, ["local_invocation_id"]);
  assert.deepEqual(
    main.body.map((st) => st.kind),
    ["var", "for", "assign", "exprStmt"],
  );
  const loop = main.body[1];
  assert.equal(loop.init.kind, "var");
  assert.equal(loop.update.kind, "assign");
  const chain = loop.body[0];
  assert.equal(chain.kind, "if");
  assert.equal(chain.otherwise[0].kind, "if", "else-if nests as an if");
});

test("a >> closing two template lists is split, while >> in an expression stays a shift", () => {
  const [decl] = parseComputeModule("var<workgroup> a: array<vec4<f32>>;");
  assert.equal(decl.type, "array<vec4<f32>>");
  const [fn] = parseComputeModule("fn f(x: u32) -> u32 { return x >> 2u; }");
  assert.equal(fn.body[0].value.op, ">>");
});

const UNSUPPORTED = [
  ["while", "fn f() { while (true) { } }", /unsupported statement 'while'/],
  ["loop", "fn f() { loop { } }", /unsupported statement 'loop'/],
  ["switch", "fn f() { switch (1) { } }", /unsupported statement 'switch'/],
  ["break", "fn f() { break; }", /unsupported statement 'break'/],
  ["continue", "fn f() { continue; }", /unsupported statement 'continue'/],
  ["discard", "fn f() { discard; }", /unsupported statement 'discard'/],
  ["address-of", "fn f() { let p = &x; }", /pointers are unsupported/],
  ["dereference", "fn f() { let v = *p; }", /pointers are unsupported/],
  [
    "module var initialiser",
    "var<private> a: f32 = 1.0;",
    /module var initialisers/,
  ],
  ["let without initialiser", "fn f() { let a: f32; }", /let without/],
  ["alias declaration", "alias T = f32;", /unsupported declaration 'alias'/],
  ["a bare expression statement", "fn f() { 1 + 2; }", /unsupported statement/],
];

function checkFailClosed(parse) {
  for (const [name, source, message] of UNSUPPORTED) {
    assert.throws(() => parse(source), message, name);
  }
}

test("every construct outside the subset throws, naming it", () => {
  checkFailClosed(parseComputeModule);
});

test("MUTANT: with the unsupported-statement guard unreachable, the fail-closed check goes red", async () => {
  const mutated = await importMutated(PARSER, [
    [
      '["while", "loop", "switch", "break", "continue", "discard"].includes(',
      'false && ["while", "loop", "switch", "break", "continue", "discard"].includes(',
    ],
  ]);
  assert.throws(
    () => checkFailClosed(mutated.parseComputeModule),
    assert.AssertionError,
  );
});
