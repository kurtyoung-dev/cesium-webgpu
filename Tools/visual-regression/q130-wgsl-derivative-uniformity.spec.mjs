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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const WGSL_ROOT = path.join(root, "packages/engine/Source/Shaders/WebGPU");

// Implicit-derivative builtins. Every one of these is legal only from uniform
// control flow; the explicit-LOD/gradient siblings (`textureSampleLevel`,
// `textureSampleGrad`, `textureSampleCompareLevel`) deliberately are not here.
const DERIVATIVE_BUILTINS = [
  "textureSample",
  "textureSampleBias",
  "textureSampleCompare",
  "dpdx",
  "dpdy",
  "dpdxFine",
  "dpdyFine",
  "dpdxCoarse",
  "dpdyCoarse",
  "fwidth",
  "fwidthFine",
  "fwidthCoarse",
];
const DERIVATIVE_CALL = new RegExp(
  `\\b(${DERIVATIVE_BUILTINS.join("|")})\\s*\\(`,
);

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

function braceDelta(line) {
  let delta = 0;
  for (let i = 0; i < line.length; ++i) {
    if (line[i] === "{") {
      delta++;
    } else if (line[i] === "}") {
      delta--;
    }
  }
  return delta;
}

// Names of user functions whose bodies reach a derivative builtin, directly or
// through another such function. Without this the analyzer would miss the shape
// GTAOGenerate.wgsl actually had: the entry called `getNormal`, which called
// `pixelToEye`, which called `readDepth`, which sampled.
function derivativeReachingFunctions(lines) {
  const bodies = new Map();
  for (let i = 0; i < lines.length; ++i) {
    const declaration = /^\s*fn\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i]);
    if (!declaration) {
      continue;
    }
    let depth = 0;
    let opened = false;
    const body = [];
    for (let j = i; j < lines.length; ++j) {
      body.push(lines[j]);
      const before = depth;
      depth += braceDelta(lines[j]);
      if (!opened && depth > before) {
        opened = true;
      }
      if (opened && depth <= 0) {
        break;
      }
    }
    bodies.set(declaration[1], body.join("\n"));
  }
  const reaching = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of bodies) {
      if (reaching.has(name)) {
        continue;
      }
      const direct = DERIVATIVE_CALL.test(body);
      const indirect = [...reaching].some((callee) =>
        new RegExp(`\\b${callee}\\s*\\(`).test(body),
      );
      if (direct || indirect) {
        reaching.add(name);
        grew = true;
      }
    }
  }
  return reaching;
}

/**
 * Report every implicit-derivative call (or call to a function that reaches
 * one) that a fragment entry point makes after it has already returned
 * conditionally.
 *
 * @param {string} source WGSL source text.
 * @returns {{line:number, symbol:string, afterReturnOnLine:number}[]} findings.
 */
export function findNonUniformDerivativeCalls(source) {
  const lines = blankComments(source);
  const reaching = derivativeReachingFunctions(lines);
  const reachingCall =
    reaching.size > 0
      ? new RegExp(`\\b(${[...reaching].join("|")})\\s*\\(`)
      : null;
  const findings = [];

  for (let i = 0; i < lines.length; ++i) {
    if (!/^\s*@fragment\b/.test(lines[i])) {
      continue;
    }
    let depth = 0;
    let opened = false;
    let poisonedAt = 0;
    for (let j = i; j < lines.length; ++j) {
      const line = lines[j];

      if (poisonedAt > 0) {
        const direct = DERIVATIVE_CALL.exec(line);
        const indirect = reachingCall ? reachingCall.exec(line) : null;
        const hit = direct ?? indirect;
        if (hit) {
          findings.push({
            line: j + 1,
            symbol: hit[1],
            afterReturnOnLine: poisonedAt,
          });
        }
      }

      const before = depth;
      depth += braceDelta(line);
      if (!opened && depth > before) {
        opened = true;
      }
      // A `return` nested inside a conditional or loop within the entry body
      // makes everything after it non-uniform. A `return` at the body's own
      // level ends the entry, so nothing follows it.
      if (/\breturn\b/.test(line) && Math.max(before, depth) > 1) {
        poisonedAt = j + 1;
      }
      if (opened && depth <= 0) {
        break;
      }
    }
  }
  return findings;
}

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

test("A7: a vertex entry point is out of scope", () => {
  const vertexOnly = SYNTHETIC_CONDITIONAL_RETURN.replace(
    "@fragment",
    "@vertex",
  );
  assert.deepEqual(findNonUniformDerivativeCalls(vertexOnly), []);
});

test("A8: explicit-LOD and gradient siblings are never findings", () => {
  for (const call of [
    "textureSampleLevel(t, s, uv, 0.0)",
    "textureSampleGrad(t, s, uv, dx, dy)",
    "textureSampleCompareLevel(t, sc, uv, 0.5)",
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
      offenders.push(
        `${path.relative(root, file)}:${finding.line} ${finding.symbol}() after the conditional return on line ${finding.afterReturnOnLine}`,
      );
    }
  }
  assert.deepEqual(offenders, []);
});

test("B2: the fleet leg is not vacuous — it reads real files with real entry points", () => {
  const files = listWgsl(WGSL_ROOT);
  assert.ok(files.length > 100, `only ${files.length} WGSL files found`);
  const withFragmentEntries = files.filter((file) =>
    /^\s*@fragment\b/m.test(fs.readFileSync(file, "utf8")),
  );
  assert.ok(
    withFragmentEntries.length > 50,
    `only ${withFragmentEntries.length} files carry a @fragment entry`,
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
