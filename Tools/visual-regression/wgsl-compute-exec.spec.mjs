// wgsl-compute-exec.spec.mjs — pins the runtime of lib/wgsl-compute-exec.mjs:
// lockstep barriers across a workgroup, zeroed per-workgroup memory, uniform
// decoding and format checks, and its fail-closed behaviour (out-of-bounds
// texel and array accesses throw, a barrier some lanes skip throws), each
// guard with an inertness mutant.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileComputeModule } from "./lib/wgsl-compute-exec.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXEC = path.join(HERE, "lib/wgsl-compute-exec.mjs");
const REAL = { compileComputeModule };

const texture = (width, height = 1, format = "rg32float") => ({
  width,
  height,
  format,
  data: new Float32Array(width * height * 4),
});

// Each lane writes its id, waits, then reads the mirrored lane's slot. Only a
// runtime that finishes every lane's write before any lane's read gets the
// mirror; a lane-at-a-time runtime reads zeros for every slot not yet written.
const MIRROR = `
@group(0) @binding(0) var Out: texture_storage_2d<rg32float, write>;
var<workgroup> s: array<f32, 8>;
@compute @workgroup_size(8, 1, 1)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let before = s[lid.x];
  s[lid.x] = f32(lid.x + 1u);
  workgroupBarrier();
  let x = i32(wid.x * 8u + lid.x);
  textureStore(Out, vec2<i32>(x, 0), vec4<f32>(s[7u - lid.x], before, 0.0, 0.0));
}
`;

test("barriers run a workgroup in lockstep and each workgroup starts with zeroed memory", () => {
  const out = texture(16);
  compileComputeModule(MIRROR).dispatch("main", { 0: out }, [2]);
  for (let x = 0; x < 16; x++) {
    assert.equal(out.data[x * 4], 8 - (x % 8), `mirror at ${x}`);
    assert.equal(out.data[x * 4 + 1], 0, `fresh workgroup memory at ${x}`);
  }
});

test("uniform structs decode by member type, and bindings are checked", () => {
  const module = compileComputeModule(`
struct P { a: u32, b: i32, c: f32, };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var Out: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(1) fn main(@builtin(local_invocation_id) l: vec3<u32>) {
  textureStore(Out, vec2<i32>(0, 0), vec4<f32>(f32(p.a), f32(p.b), p.c, 0.0));
}`);
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 7, true);
  view.setInt32(4, -3, true);
  view.setFloat32(8, 0.5, true);
  const out = texture(1, 1, "rgba32float");
  module.dispatch("main", { 0: { bytes }, 1: out }, [1]);
  assert.deepEqual(Array.from(out.data), [7, -3, 0.5, 0]);
  assert.throws(
    () => module.dispatch("main", { 0: { bytes } }, [1]),
    /binding 1 not bound/,
  );
  assert.throws(
    () => module.dispatch("main", { 0: { bytes }, 1: texture(1) }, [1]),
    /declared rgba32float, bound rg32float/,
  );
  assert.throws(() => module.dispatch("nope", {}, [1]), /no entry point nope/);
});

const OOB_TEXEL = `
@group(0) @binding(0) var Out: texture_storage_2d<rg32float, write>;
@compute @workgroup_size(1) fn main(@builtin(local_invocation_id) l: vec3<u32>) {
  textureStore(Out, vec2<i32>(4, 0), vec4<f32>(1.0, 1.0, 0.0, 0.0));
}`;
const OOB_ARRAY = `
@group(0) @binding(0) var Out: texture_storage_2d<rg32float, write>;
var<workgroup> s: array<f32, 4>;
@compute @workgroup_size(1) fn main(@builtin(local_invocation_id) l: vec3<u32>) {
  textureStore(Out, vec2<i32>(0, 0), vec4<f32>(s[l.x + 4u], 0.0, 0.0, 0.0));
}`;
const DIVERGENT = `
@group(0) @binding(0) var Out: texture_storage_2d<rg32float, write>;
@compute @workgroup_size(4) fn main(@builtin(local_invocation_id) l: vec3<u32>) {
  if (l.x < 2u) {
    workgroupBarrier();
  }
  textureStore(Out, vec2<i32>(i32(l.x), 0), vec4<f32>(1.0, 0.0, 0.0, 0.0));
}`;

const checkOobTexel = (exec) =>
  assert.throws(
    () =>
      exec
        .compileComputeModule(OOB_TEXEL)
        .dispatch("main", { 0: texture(4) }, [1]),
    /texel \(4, 0\) outside/,
  );
const checkOobArray = (exec) =>
  assert.throws(
    () =>
      exec
        .compileComputeModule(OOB_ARRAY)
        .dispatch("main", { 0: texture(1) }, [1]),
    /index 4 out of bounds \[0, 4\)/,
  );
const checkDivergent = (exec) =>
  assert.throws(
    () =>
      exec
        .compileComputeModule(DIVERGENT)
        .dispatch("main", { 0: texture(4) }, [1]),
    /reached by some invocations of a workgroup but not all/,
  );

test("fail closed: an out-of-bounds texel, an out-of-bounds array index and a divergent barrier throw", () => {
  checkOobTexel(REAL);
  checkOobArray(REAL);
  checkDivergent(REAL);
});

test("MUTANT: an unreachable texel bounds check goes red", async () => {
  const exec = await importMutated(EXEC, [
    [
      "if (!(x >= 0 && x < tex.width && y >= 0 && y < tex.height)) {",
      "if (false && !(x >= 0 && x < tex.width && y >= 0 && y < tex.height)) {",
    ],
  ]);
  assert.throws(() => checkOobTexel(exec), assert.AssertionError);
});

test("MUTANT: an unreachable array bounds check goes red", async () => {
  const exec = await importMutated(EXEC, [
    [
      "if (!(index >= 0 && index < length)) {",
      "if (false && !(index >= 0 && index < length)) {",
    ],
  ]);
  assert.throws(() => checkOobArray(exec), assert.AssertionError);
});

test("MUTANT: an unreachable divergent-barrier check goes red", async () => {
  const exec = await importMutated(EXEC, [
    ["if (done !== 0) {", "if (false && done !== 0) {"],
  ]);
  assert.throws(() => checkDivergent(exec), assert.AssertionError);
});
