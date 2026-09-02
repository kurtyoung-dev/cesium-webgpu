// q130-wgsl-derivative-uniformity.spec.mjs — pure Node: no browser, no GPU.
//
// @purpose Guards the WGSL rule that made frustum-dev's phongTextured shader module invalid: no implicit-derivative sampling after a conditional return in a fragment entry point.
// @status ACTIVE
//
// WHAT WENT WRONG. On WebGPU the `frustum-dev` gallery demo reported, three
// times per load:
//
//   [Invalid ShaderModule "phongTextured Shader"] is invalid due to a previous
//   error. - While validating vertex stage (entryPoint: "vertexMain").
//
// The module was not merely mislabelled: `createShaderModule` had produced an
// error module, so every pipeline built from it was invalid. WebGL was clean on
// the same demo.
//
// WHY THAT SHADER, AND WHY THAT DEMO. `FrustumGeometry.createGeometry` decides
// whether to compute normals/tangents/st with `defined(vertexFormat.normal)`,
// and a `VertexFormat` field is a boolean that is always defined — so the demo's
// `VertexFormat.POSITION_ONLY` frustum still arrives carrying normals AND st.
// `selectWebGPUShader` reads those two attributes and picks `phongTextured`,
// which is otherwise almost never instantiated. That shader's fragment entry
// runs the clipping-plane preamble — a `discard`, then an early `return edgeOut`
// under a condition derived from `input.viewPosition` — before sampling the base
// colour with `textureSample`. WGSL permits implicit-derivative sampling only
// from uniform control flow, and a conditional `return` makes the code after it
// non-uniform. `PrimitiveBasicTexturedColor.wgsl` samples at the top of its
// entry and compiles; `PrimitivePhongColor.wgsl` has the same preamble but no
// sampler and compiles. Only the combination fails.
//
// WHY THIS IS NOT A NAGA SPEC, AND WHY IT ALSO IS ONE. The repo's naga tooling
// does NOT enforce this rule for the conditional-return shape — group E proves
// that with a synthetic module naga accepts and Dawn rejects. A naga leg alone
// would therefore be an instrument that cannot see the defect it is named after.
// So the guard is a source analyzer (groups A–D), and naga runs alongside it
// (group E) on the REAL assembled module for both define legs, which is the leg
// that catches ordinary WGSL breakage in the same file.
//
// `discard` IS DELIBERATELY NOT TREATED AS POISON. WGSL's `discard` demotes the
// invocation to a helper and does not make later control flow non-uniform.
// `Collections/BillboardCollection.wgsl` discards under two non-uniform
// conditions and then calls `textureSample`, and billboards render on WebGPU —
// treating `discard` as poison would make this guard red on working code.
//
// CRLF: the repo checks out with `core.autocrlf=true`. The analyzer splits on
// "\n" and never depends on the terminator, and A9 asserts a CRLF source and its
// LF twin produce identical findings.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyze } from "./lib/wgsl-derivative-uniformity.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const WGSL_ROOT = path.join(root, "packages/engine/Source/Shaders/WebGPU");
const ANALYZER_MODULE = path.join(here, "lib/wgsl-derivative-uniformity.mjs");

// Blank out comments while keeping every line's identity, so reported line
// numbers are the numbers a reader sees in the file.
function blankComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
  return withoutBlocks.split("\n").map((line) => {
    const marker = line.indexOf("//");
    return marker >= 0 ? line.slice(0, marker) : line;
  });
}

const findNonUniformDerivativeCalls = analyze;

function listWgsl(directory) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      out.push(...listWgsl(full));
    } else if (entry.name.endsWith(".wgsl")) {
      out.push(full);
    }
  }
  return out;
}

function assertFleetNotVacuous(
  files,
  readFile = (file) => fs.readFileSync(file, "utf8"),
) {
  assert.ok(files.length > 100, `only ${files.length} WGSL files found`);
  const withFragmentEntries = files.filter((file) =>
    /^\s*@fragment\b/m.test(readFile(file)),
  );
  assert.ok(
    withFragmentEntries.length > 50,
    `only ${withFragmentEntries.length} files carry a @fragment entry`,
  );
}

const PHONG_TEXTURED = path.join(
  WGSL_ROOT,
  "Primitive/PrimitivePhongTexturedColor.wgsl",
);

// ── Group A — the analyzer sees what naga cannot ────────────────────────────

const SYNTHETIC_CONDITIONAL_RETURN = `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@fragment
fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    if (uv.x > 0.5) {
        return vec4<f32>(1.0);
    }
    return textureSample(t, s, uv);
}
`;

test("A1: a conditional return before textureSample is reported", () => {
  const findings = findNonUniformDerivativeCalls(SYNTHETIC_CONDITIONAL_RETURN);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].symbol, "textureSample");
});

test("A2: the same sample WITHOUT the early return is clean", () => {
  const clean = SYNTHETIC_CONDITIONAL_RETURN.replace(
    "    if (uv.x > 0.5) {\n        return vec4<f32>(1.0);\n    }\n",
    "",
  );
  assert.ok(!clean.includes("if (uv.x > 0.5)"), "mutation did not apply");
  assert.deepEqual(findNonUniformDerivativeCalls(clean), []);
});

test("A3: a bare discard is not treated as poison", () => {
  const withDiscard = `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@fragment
fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    if (uv.x > 0.5) { discard; }
    return textureSample(t, s, uv);
}
`;
  assert.deepEqual(findNonUniformDerivativeCalls(withDiscard), []);
});

test("A4: the indirect shape GTAO actually had is reported", () => {
  const indirect = `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn readDepth(uv: vec2<f32>) -> f32 { return textureSample(t, s, uv).r; }
fn pixelToEye(uv: vec2<f32>) -> f32 { return readDepth(uv); }
@fragment
fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    if (uv.x > 0.99) {
        return vec4<f32>(1.0);
    }
    let d = pixelToEye(uv);
    return vec4<f32>(d, d, d, 1.0);
}
`;
  const findings = findNonUniformDerivativeCalls(indirect);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].symbol, "pixelToEye");
});

test("A5: a comment mentioning the builtin is not a finding", () => {
  const commented = SYNTHETIC_CONDITIONAL_RETURN.replace(
    "    return textureSample(t, s, uv);",
    "    // textureSample(t, s, uv) would be illegal here\n    return textureSampleLevel(t, s, uv, 0.0);",
  );
  assert.deepEqual(findNonUniformDerivativeCalls(commented), []);
});

test("A6: comments do not shift reported line numbers", () => {
  const withBlock = `/* one\n   two\n   three */\n${SYNTHETIC_CONDITIONAL_RETURN}`;
  const findings = findNonUniformDerivativeCalls(withBlock);
  assert.equal(findings.length, 1);
  const lines = withBlock.split("\n");
  assert.match(lines[findings[0].line - 1], /textureSample\(/);
});

test("A7: only fragment-reachable helpers are in derivative-uniformity scope", () => {
  const nonFragmentStages = `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn sampleAfterReturn(uv: vec2<f32>, stop: bool) -> vec4<f32> {
    if (stop) {
        return vec4<f32>(0.0);
    }
    return textureSample(t, s, uv);
}
@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let ignored = sampleAfterReturn(vec2<f32>(f32(index)), false);
    return vec4<f32>(ignored.xyz, 1.0);
}
@compute @workgroup_size(1)
fn computeMain() {
    let ignored = sampleAfterReturn(vec2<f32>(0.0), false);
}
`;
  assert.deepEqual(findNonUniformDerivativeCalls(nonFragmentStages), []);

  const fragmentCaller = `
@fragment
fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    return sampleAfterReturn(uv, uv.x > 0.5);
}
`;
  const mixedStages = `${nonFragmentStages}${fragmentCaller}`;
  const findings = findNonUniformDerivativeCalls(mixedStages);
  assert.ok(
    findings.some((finding) => finding.symbol === "textureSample"),
    "the helper becomes illegal when a fragment entry reaches it",
  );
  assert.deepEqual(
    findNonUniformDerivativeCalls(mixedStages.replace(fragmentCaller, "")),
    [],
    "removing fragment reachability must restore the clean control",
  );
});

test("A8: explicit-level, gradient, compare-level, and load siblings are clean", () => {
  for (const call of [
    "textureSampleLevel(t, s, uv, 0.0)",
    "textureSampleGrad(t, s, uv, dx, dy)",
    "textureSampleCompareLevel(t, sc, uv, 0.5)",
    "textureLoad(t, vec2<i32>(0), 0)",
  ]) {
    const source = SYNTHETIC_CONDITIONAL_RETURN.replace(
      "textureSample(t, s, uv)",
      call,
    );
    assert.deepEqual(
      findNonUniformDerivativeCalls(source),
      [],
      `${call} must not be flagged`,
    );
  }
});

test("A9: CRLF and LF sources produce identical findings", () => {
  const lf = SYNTHETIC_CONDITIONAL_RETURN;
  const crlf = lf.split("\n").join("\r\n");
  assert.deepEqual(
    findNonUniformDerivativeCalls(crlf),
    findNonUniformDerivativeCalls(lf),
  );
});

// ── Group B — the fleet ─────────────────────────────────────────────────────

test("B1: no WGSL shader samples with implicit derivatives after a conditional return", () => {
  const offenders = [];
  for (const file of listWgsl(WGSL_ROOT)) {
    for (const finding of findNonUniformDerivativeCalls(
      fs.readFileSync(file, "utf8"),
    )) {
      // The line the non-uniform flow starts on depends on the shape the
      // analyzer reported, so a break or continue finding names its own line
      // instead of printing "return on line undefined".
      const flowLine =
        finding.afterReturnOnLine ??
        finding.afterBreakOnLine ??
        finding.afterContinueOnLine ??
        "?";
      offenders.push(
        `${path.relative(root, file)}:${finding.line} ${finding.symbol}() reached through ${finding.shape} on line ${flowLine}`,
      );
    }
  }
  assert.deepEqual(offenders, []);
});

test("B2: the fleet leg is not vacuous — it reads real files with real entry points", () => {
  assertFleetNotVacuous(listWgsl(WGSL_ROOT));
});

test("B3: an empty fleet fails the non-vacuity gate", () => {
  assert.throws(() => assertFleetNotVacuous([]), /only 0 WGSL files found/);
});

test("B4: a traversal with zero fragment entry points fails the gate", () => {
  const files = Array.from(
    { length: 101 },
    (_, index) => `empty-${index}.wgsl`,
  );
  assert.throws(
    () => assertFleetNotVacuous(files, () => "fn helper() {}"),
    /only 0 files carry a @fragment entry/,
  );
});

// ── Group C — inertness mutants against the shipped fix ─────────────────────

test("C1: restoring the plain textureSample in the shipped shader turns B1 red", () => {
  const source = fs.readFileSync(PHONG_TEXTURED, "utf8");
  assert.deepEqual(findNonUniformDerivativeCalls(source), []);
  const mutant = source.replace(
    /let texColor = textureSampleGrad\([\s\S]*?\);/,
    "let texColor = textureSample(colorTexture, textureSampler, input.texCoord);",
  );
  assert.notEqual(mutant, source, "mutation did not apply");
  const findings = findNonUniformDerivativeCalls(mutant);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].symbol, "textureSample");
});

test("C2: sinking the hoisted gradients below the clipping preamble turns B1 red", () => {
  const source = fs.readFileSync(PHONG_TEXTURED, "utf8");
  const hoist =
    / {4}let texCoordDx = dpdx\(input\.texCoord\);\r?\n {4}let texCoordDy = dpdy\(input\.texCoord\);\r?\n/;
  assert.match(source, hoist, "hoisted gradients not found");
  const mutant = source
    .replace(hoist, "")
    .replace(
      "    let texColor = textureSampleGrad(",
      "    let texCoordDx = dpdx(input.texCoord);\n    let texCoordDy = dpdy(input.texCoord);\n    let texColor = textureSampleGrad(",
    );
  const findings = findNonUniformDerivativeCalls(mutant);
  assert.ok(
    findings.some((finding) => finding.symbol === "dpdx"),
    "sinking the gradients past the early return must be reported",
  );
});

test("C3: the shipped shader still hoists BEFORE the clipping preamble", () => {
  const source = fs.readFileSync(PHONG_TEXTURED, "utf8");
  const hoistAt = source.indexOf("let texCoordDx = dpdx(input.texCoord);");
  const discardAt = source.indexOf("if (clipByPlanes(input.viewPosition))");
  const sampleAt = source.indexOf("textureSampleGrad(");
  assert.ok(hoistAt > 0 && discardAt > 0 && sampleAt > 0);
  assert.ok(
    hoistAt < discardAt,
    "gradients must be taken before the clipping discard",
  );
  assert.ok(discardAt < sampleAt, "the sample still follows the preamble");
});

// ── Group D — GTAO, the other instance the analyzer found ───────────────────

test("D1: GTAOGenerate reads depth and noise with explicit LOD", () => {
  const source = fs.readFileSync(
    path.join(WGSL_ROOT, "PostProcess/GTAOGenerate.wgsl"),
    "utf8",
  );
  assert.ok(
    !/(^|[^A-Za-z])textureSample\s*\(/m.test(blankComments(source).join("\n")),
    "GTAOGenerate must not use implicit-derivative sampling",
  );
  assert.match(source, /textureSampleLevel\(depthTexture/);
  assert.match(source, /textureSampleLevel\(randomTexture/);
});

// ── Group E — naga on the REAL assembled phongTextured module ───────────────

// Mirror of the two source transforms `WebGPUPrimitiveCommands` applies before
// `device.createShaderModule`: the point-shadow chunk splice performed by
// `WebGPUPrimitiveShaders.getShaderSource`, and the clustered-lighting chunk
// prepend with the effects-group token resolved to 3 (phongTextured is a
// textured layout, so its effects bind group sits at @group(3)).
function assemblePhongTexturedModule(defines) {
  const chunk = (relative) =>
    fs.readFileSync(path.join(WGSL_ROOT, relative), "utf8");
  let source = fs.readFileSync(PHONG_TEXTURED, "utf8");
  if (/^\s*\/\/.*@chunk\s+csm_samplePointShadow\b/m.test(source)) {
    source = `${chunk("chunks/functions/csm_samplePointShadow.wgsl")}\n${source}`;
  }
  if (source.includes("evalClusteredLights(")) {
    const clustered = chunk("chunks/structs/ClusteredLighting.wgsl")
      .split("__CL_GROUP__")
      .join("3");
    source = `${clustered}\n${source}`;
  }
  const active = new Set(defines);
  const directive =
    /^\s*\/\/>>\s*(ifdef|else|endif)(?:\s+([A-Z_][A-Z0-9_]*))?\s*$/;
  const out = [];
  const stack = [];
  for (const line of source.split("\n")) {
    const match = directive.exec(line);
    if (match) {
      if (match[1] === "ifdef") {
        stack.push({ on: active.has(match[2]), inElse: false });
      } else if (match[1] === "else") {
        stack[stack.length - 1].inElse = true;
      } else {
        stack.pop();
      }
      continue;
    }
    if (stack.every((frame) => (frame.inElse ? !frame.on : frame.on))) {
      out.push(line);
    }
  }
  return out.join("\n");
}

async function loadNaga() {
  const directory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(directory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(directory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  return naga;
}

test("E1: the assembled phongTextured module validates on both define legs", async () => {
  const naga = await loadNaga();
  for (const defines of [[], ["LOG_DEPTH"]]) {
    const assembled = assemblePhongTexturedModule(defines);
    assert.ok(
      assembled.includes("fn fragmentMain"),
      "assembly lost the fragment entry",
    );
    assert.ok(
      assembled.includes("textureSampleGrad("),
      "assembly lost the base-colour sample",
    );
    assert.doesNotThrow(
      () => naga.validate_wgsl(assembled),
      `defines=[${defines.join(",")}]`,
    );
  }
});

test("E2: naga does NOT enforce this rule — the reason group B exists", async () => {
  const naga = await loadNaga();
  assert.equal(
    findNonUniformDerivativeCalls(SYNTHETIC_CONDITIONAL_RETURN).length,
    1,
    "the analyzer must see this module as a violation",
  );
  assert.doesNotThrow(
    () => naga.validate_wgsl(SYNTHETIC_CONDITIONAL_RETURN),
    "if naga ever starts rejecting this, prefer naga over the analyzer",
  );
});

test("E3: the assembly is not a fixture — the raw shader alone does not validate", async () => {
  const naga = await loadNaga();
  const rawOnly = fs
    .readFileSync(PHONG_TEXTURED, "utf8")
    .replace(/\r\n/g, "\n");
  assert.throws(
    () => naga.validate_wgsl(rawOnly),
    "the raw shader alone must not validate, or E1 proves nothing",
  );
});

// Group F - hardened textual-control shapes.

const SHAPE_BINDINGS = `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
`;

const SINGLE_LINE_CONDITIONAL_RETURN = `${SHAPE_BINDINGS}
fn a(uv: vec2<f32>, k: f32) -> vec4<f32> { if (k < 0.5) { return vec4<f32>(0.0); } return textureSample(t, s, uv); }
`;

const CONDITIONAL_BREAK = `${SHAPE_BINDINGS}
fn c(uv: vec2<f32>, n: i32) -> vec4<f32> { var acc = vec4<f32>(0.0); for (var i = 0; i < 8; i = i + 1) { if (i > n) { break; } acc = acc + textureSample(t, s, uv); } return acc; }
`;

const CONDITIONAL_CONTINUE = `${SHAPE_BINDINGS}
fn d(uv: vec2<f32>, n: i32) -> vec4<f32> { var acc = vec4<f32>(0.0); for (var i = 0; i < 8; i = i + 1) { if (i == n) { continue; } acc = acc + textureSample(t, s, uv); } return acc; }
`;

const SAMPLE_INSIDE_NON_UNIFORM_IF = `${SHAPE_BINDINGS}
fn e(uv: vec2<f32>, k: f32) -> vec4<f32> { var c = vec4<f32>(0.0); if (k < 0.5) { c = textureSample(t, s, uv); } return c; }
`;

const HOISTED_SAMPLE = `${SHAPE_BINDINGS}
fn f(uv: vec2<f32>, k: f32) -> vec4<f32> { let c = textureSample(t, s, uv); if (k < 0.5) { return vec4<f32>(0.0); } return c; }
`;

const EXPLICIT_LEVEL_SAMPLE = `${SHAPE_BINDINGS}
fn g(uv: vec2<f32>, k: f32) -> vec4<f32> { let c = textureSampleLevel(t, s, uv, 0.0); if (k < 0.5) { return c * 0.5; } return c; }
`;

const FLAGGED_SHAPE_FIXTURES = [
  {
    name: "single-line conditional return",
    shape: "conditional-return",
    source: SINGLE_LINE_CONDITIONAL_RETURN,
  },
  {
    name: "conditional break",
    shape: "conditional-break",
    source: CONDITIONAL_BREAK,
  },
  {
    name: "conditional continue",
    shape: "conditional-continue",
    source: CONDITIONAL_CONTINUE,
  },
  {
    name: "sample inside a non-uniform if",
    shape: "non-uniform-if",
    source: SAMPLE_INSIDE_NON_UNIFORM_IF,
  },
];

for (const [index, fixture] of FLAGGED_SHAPE_FIXTURES.entries()) {
  test(`F${index + 1}: ${fixture.name} is reported by shape`, () => {
    const findings = analyze(fixture.source);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].symbol, "textureSample");
    assert.equal(findings[0].shape, fixture.shape);
  });
}

test("F5: a sample hoisted above the conditional stays clean", () => {
  assert.deepEqual(analyze(HOISTED_SAMPLE), []);
});

test("F6: an explicit-level sample stays clean", () => {
  assert.deepEqual(analyze(EXPLICIT_LEVEL_SAMPLE), []);
});

test("F7: disabling the hardened detector makes all four new fixtures inert", async () => {
  const original = fs.readFileSync(ANALYZER_MODULE, "utf8");
  const mutant = original.replace(
    "const HARDENED_SHAPES = true;",
    "const HARDENED_SHAPES = false;",
  );
  assert.notEqual(mutant, original, "analyzer mutation did not apply");

  const mutantUrl = `data:text/javascript;base64,${Buffer.from(mutant).toString(
    "base64",
  )}#q130-hardened-shapes-disabled`;
  const { analyze: analyzeMutant } = await import(mutantUrl);

  for (const fixture of FLAGGED_SHAPE_FIXTURES) {
    assert.deepEqual(
      analyzeMutant(fixture.source),
      [],
      `${fixture.name} must disappear when hardened detection is disabled`,
    );
  }
});

// Group G - scope, uniformity, and tokenizer assumptions.

test("G1: a helper-only module with no entry point is treated as a fragment-library candidate", () => {
  const findings = analyze(SINGLE_LINE_CONDITIONAL_RETURN);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].shape, "conditional-return");
});

test("G2: a module-uniform condition is clean and a fragment-input condition is red", () => {
  const uniformCondition = `
struct Params { enabled: u32, };
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var<uniform> params: Params;
@fragment
fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    var color = vec4<f32>(0.0);
    if (params.enabled != 0u) {
        color = textureSample(t, s, uv);
    }
    return color;
}
`;
  assert.deepEqual(analyze(uniformCondition), []);

  const varyingCondition = uniformCondition.replace(
    "params.enabled != 0u",
    "uv.x > 0.5",
  );
  const findings = analyze(varyingCondition);
  assert.ok(
    findings.some(
      (finding) =>
        finding.symbol === "textureSample" &&
        finding.shape === "non-uniform-if",
    ),
  );
});

test("G3: tokenizer, CRLF, and call propagation preserve the same finding", () => {
  const source = `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn helper(uv: vec2<f32>) -> vec4<f32> {
    /* textureSample(t, s, uv) in a comment is inert. */
    return textureSample(t, s, uv);
}
@fragment
fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let epsilon = 1.0e-3;
    if ((uv.x + epsilon) >= 0.5 && uv.y != 0.0) {
        return vec4<f32>(1.0);
    }
    return helper(uv);
}
`;
  const lf = analyze(source);
  const crlf = analyze(source.split("\n").join("\r\n"));
  assert.deepEqual(crlf, lf);
  assert.ok(
    lf.some(
      (finding) =>
        finding.symbol === "helper" && finding.shape === "conditional-return",
    ),
  );
});

// Group H - preregistered physical-site repairs and one-at-a-time mutants.

const PHYSICAL_SITE_GROUPS = [
  {
    file: path.join(WGSL_ROOT, "chunks/functions/csm_clipByPolygons.wgsl"),
    replacements: [
      {
        name: "polygon clip sample 1",
        implicit: "let sdfValue = textureSample(sdfTex, sdfSamp, uv).r;",
        explicit:
          "let sdfValue = textureSampleLevel(sdfTex, sdfSamp, uv, 0.0).r;",
        occurrence: 0,
        symbol: "textureSample",
        shape: "conditional-return",
      },
      {
        name: "polygon clip sample 2",
        implicit: "let sdfValue = textureSample(sdfTex, sdfSamp, uv).r;",
        explicit:
          "let sdfValue = textureSampleLevel(sdfTex, sdfSamp, uv, 0.0).r;",
        occurrence: 1,
        symbol: "textureSample",
        shape: "conditional-return",
      },
    ],
  },
  {
    file: path.join(WGSL_ROOT, "chunks/functions/csm_effects.wgsl"),
    replacements: [
      {
        name: "hard shadow compare",
        implicit:
          "return textureSampleCompare(shadowMap, shadowSampler, uv, depth);",
        explicit:
          "return textureSampleCompareLevel(shadowMap, shadowSampler, uv, depth);",
        occurrence: 0,
        symbol: "textureSampleCompare",
        shape: "conditional-return",
      },
      {
        name: "PCF shadow compare",
        implicit:
          "shadow += textureSampleCompare(shadowMap, shadowSampler, uv + offset, depth);",
        explicit:
          "shadow += textureSampleCompareLevel(shadowMap, shadowSampler, uv + offset, depth);",
        occurrence: 0,
        symbol: "textureSampleCompare",
        shape: "conditional-return",
      },
    ],
  },
  {
    file: path.join(WGSL_ROOT, "Voxels/VoxelRayMarch.wgsl"),
    replacements: [
      {
        name: "voxel density sample",
        implicit: "return textureSample(volumeTexture, volumeSampler, uvw).r;",
        explicit:
          "return textureSampleLevel(volumeTexture, volumeSampler, uvw, 0.0).r;",
        occurrence: 0,
        symbol: "csm_sampleVoxelDensity",
        shape: "conditional-break",
      },
    ],
  },
];

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function replaceOccurrence(source, needle, replacement, occurrence) {
  let cursor = -1;
  for (let index = 0; index <= occurrence; ++index) {
    cursor = source.indexOf(needle, cursor + 1);
  }
  assert.ok(cursor >= 0, `occurrence ${occurrence} of ${needle} not found`);
  return (
    source.slice(0, cursor) + replacement + source.slice(cursor + needle.length)
  );
}

function repairedPhysicalSources() {
  const repaired = new Map();
  for (const group of PHYSICAL_SITE_GROUPS) {
    let source = fs.readFileSync(group.file, "utf8");
    const uniqueReplacements = new Map(
      group.replacements.map((site) => [site.implicit, site.explicit]),
    );
    for (const [implicit, explicit] of uniqueReplacements) {
      const expected = group.replacements.filter(
        (site) => site.implicit === implicit,
      ).length;
      const actual =
        occurrenceCount(source, implicit) + occurrenceCount(source, explicit);
      assert.equal(
        actual,
        expected,
        `${path.relative(root, group.file)} physical site count changed`,
      );
      source = source.split(implicit).join(explicit);
    }
    repaired.set(group.file, source);
  }
  return repaired;
}

test("H1: the preregistered explicit-level physical-site baseline is analyzer-clean", () => {
  for (const [file, source] of repairedPhysicalSources()) {
    assert.deepEqual(analyze(source), [], path.relative(root, file));
  }
});

test("H2: shipped physical sites match the preregistered explicit-level baseline", () => {
  const repaired = repairedPhysicalSources();
  const mismatches = [];
  for (const [file, expected] of repaired) {
    if (fs.readFileSync(file, "utf8") !== expected) {
      mismatches.push(path.relative(root, file));
    }
  }
  assert.deepEqual(mismatches, []);
});

const PHYSICAL_MUTANTS = PHYSICAL_SITE_GROUPS.flatMap((group) =>
  group.replacements.map((site) => ({ ...site, file: group.file })),
);

for (const [index, site] of PHYSICAL_MUTANTS.entries()) {
  test(`H${index + 3}: ${site.name} implicit-sample mutant turns red`, () => {
    const baseline = repairedPhysicalSources().get(site.file);
    assert.equal(occurrenceCount(baseline, site.implicit), 0);
    const mutant = replaceOccurrence(
      baseline,
      site.explicit,
      site.implicit,
      site.occurrence,
    );
    assert.equal(occurrenceCount(mutant, site.implicit), 1);
    const findings = analyze(mutant);
    assert.ok(
      findings.some(
        (finding) =>
          finding.symbol === site.symbol && finding.shape === site.shape,
      ),
      `${site.name} did not produce ${site.symbol}/${site.shape}`,
    );
  });
}
