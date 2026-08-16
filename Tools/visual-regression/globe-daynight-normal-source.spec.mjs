// globe-daynight-normal-source.spec.mjs — CO-15, DEFERRED_WORK row
// `NEW-WEBGPU-GLOBE-DAYNIGHT-NORMAL-SOURCE` (CELESTIAL_LIGHT_TRANSPORT_PLAN
// 2026-08-07 §2 bug 2, fifth divergence).
// @purpose Pins that every WGSL globe day/night term reads the analytic geocentric normal, not the mesh v_normalEC whose constant decode flattened lighting.
// @status ACTIVE
//
// WHAT THIS ROW FIXED. `GlobeTerrain.wgsl`'s day/night FAMILY — the imagery
// day/night alpha, the night-lights emission gate, the DAYNIGHT_SHADING Lambert
// term and `computeTerminatorGlow` — read `input.v_normalEC`, the interpolated
// MESH vertex normal. On terrain with no vertex normals that is not a normal at
// all: the uncompressed no-extras pipeline declares the attribute `float32x2`
// (`WebGPUGlobeSurfacePipelines.ts:270-289`), so the shader's `.z` read is the
// WebGPU default 0.0 and `octDecode(0.0)` is the CONSTANT (0, 0, -1); the
// quantized+webMercatorT entry point passes the literal 32896.0 = (0, 0, +1).
// `dot(N, L)` was therefore ONE number for the entire globe and every day/night
// term was globally uniform. Every terrain provider this fork can stand up
// offline reports `hasVertexNormals === false`, so that was the DEFAULT path.
//
// Pixel evidence, not inference: `probe-daynight-terminator-law.mjs`'s first run
// (tip 6e9c997287, Batch 915) measured a WebGPU day-fade slope of 0.000 across
// the fit window and returned lane A STRUCTURAL — refusing to bank the recorded
// `+0.5` mechanism off a reading a constant normal produces for free.
//
// THE FIX. `fragmentMain` derives `dayNightNormalEC` — the analytic geocentric
// surface normal, recomputed per fragment and carried into eye space — and every
// day/night-family consumer takes it. Section A pins that. Section D requires
// the pins to REJECT a source in which `input.v_normalEC` is put back.
//
// WHY UNCONDITIONAL, AND WHY THAT IS WEBGL'S SHAPE RATHER THAN A PREFERENCE.
// `GlobeSurfaceShaderSet.js:435-442` emits `ENABLE_VERTEX_LIGHTING` and
// `ENABLE_DAYNIGHT_SHADING` as MUTUALLY EXCLUSIVE arms of `if (hasVertexNormals)`.
// So WebGL's day/night term exists ONLY on normal-less terrain, and there it
// reads the analytic normal (`GlobeFS.glsl:595-597`); on vertex-normal terrain
// the term does not exist at all (`GlobeFS.glsl:600`'s double guard fails and
// `nightBlend = 0.0`) — and `GlobeVS.glsl:267` does not even WRITE `v_normalEC`
// unless one of ENABLE_VERTEX_LIGHTING / GENERATE_POSITION_AND_NORMAL /
// APPLY_MATERIAL is defined, so the day/night path has no mesh normal to read.
// The mesh normal is thus never the source of WebGL's day/night term on EITHER
// terrain kind. Section B executes that reading against the WebGL sources so the
// decision stays anchored to them rather than to this comment.
//
// WHAT IS *NOT* FIXED HERE, recorded so the next reader does not assume it was:
//   • CLT-B4 — the `+0.5` in `computeDayNightFade`. **CLOSED at Batch 925
//     (CO-18), AFTER this row.** Section E1 is now INVERTED: it pins that the
//     offset is gone and that `computeDayNightFade` runs GLSL's law. The full
//     pair contract lives in `globe-daynight-ramp-law.spec.mjs`; the consumer
//     pin in section A moved with it (`computeDayNightDiffuse` replaced the
//     inline `dayNightNdotL * 0.88 + ambient`), because the NORMAL-SOURCE
//     obligation is about which normal each consumer reads, not which
//     expression it evaluates.
//   • CLT-B1 finding (c) — WebGPU still APPLIES the ramp on vertex-normal
//     terrain where WebGL gates it off. Needs a `hasVertexNormals === true`
//     provider to decide at pixels (row
//     `CLT-B1-VERTEX-NORMAL-LANE-NEEDS-A-NETWORK-LANE`).
//   • `computeAtmosphereColor` still takes the MESH normal (section A4). It is a
//     WGSL-only fog/atmosphere approximation with no GLSL twin that takes a
//     surface normal at all, so there is no WebGL law to match and moving it
//     would move fog colour on evidence this batch did not gather. It IS a
//     second consumer of the same constant on normal-less terrain — recorded,
//     not silently fixed (Principle 9).
//
// LINE ENDINGS: this repo checks out CRLF. Every source read is normalised to
// `\n` first — a spec anchored on a bare `\n` false-greens on a CRLF checkout.
//
// Run: node --test Tools/visual-regression/globe-daynight-normal-source.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

const WGSL_PATH =
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const PIPELINES_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts";

const wgsl = read(WGSL_PATH);
const pipelines = read(PIPELINES_PATH);
const shaderSet = read("packages/engine/Source/Scene/GlobeSurfaceShaderSet.js");
const globeFs = read("packages/engine/Source/Shaders/GlobeFS.glsl");
const globeVs = read("packages/engine/Source/Shaders/GlobeVS.glsl");

/** WGSL has only line comments. Absence checks must never run on raw text. */
function stripWgslComments(source) {
  return source.replace(/^[ \t]*\/\/[^\n]*$/gm, "").replace(/\/\/[^\n]*/g, "");
}

function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const wgslCode = stripWgslComments(wgsl);
const pipelinesCode = stripJsComments(pipelines);
const shaderSetCode = stripJsComments(shaderSet);

// ─── the predicates, as functions of a source string ─────────────────────────
//
// Every section-A assertion is expressed as a predicate over an arbitrary WGSL
// string so section D can run the SAME predicates against deliberately-broken
// copies. A gate that only ever sees the correct input certifies nothing.

/** The analytic normal is derived exactly once, from `v_positionMC`. */
export function derivesAnalyticNormal(source) {
  const code = stripWgslComments(source);
  const matches =
    code.match(
      /let dayNightNormalEC = normalize\(\s*\(camera\.modifiedModelView \*\s*vec4<f32>\(normalize\(input\.v_positionMC\), 0\.0\)\)\.xyz,\s*\);/g,
    ) ?? [];
  return matches.length === 1;
}

/** Each day/night-family consumer, and the argument it must take. */
const DAYNIGHT_CONSUMERS = Object.freeze([
  {
    name: "imagery day/night alpha + night-lights gate",
    pattern: /dayFade = computeDayNightFade\(dayNightNormalEC, sunDir\);/,
  },
  {
    // CLT-B4 (CO-18) rewrote this consumer: the DAYNIGHT diffuse is no longer
    // an inline `dayNightNdotL * 0.88 + ambient`, it is WebGL's
    // `clamp(N·L*5 + 0.3, 0, 1)` behind `computeDayNightDiffuse`. The
    // NORMAL-SOURCE obligation this row owns is unchanged — the analytic
    // normal is still what the term reads — so the pin follows the expression.
    name: "DAYNIGHT_SHADING diffuse",
    pattern:
      /let dayNightDiffuse = computeDayNightDiffuse\(dayNightNormalEC, sunDir\);/,
  },
  {
    name: "terminator glow",
    pattern:
      /computeTerminatorGlow\(dayNightNormalEC, sunDir\)\s*\*\s*terminatorGlowStrength\s*\*\s*eclipseAbsolute;/,
  },
]);

export function consumersTakeAnalyticNormal(source) {
  const code = stripWgslComments(source);
  return DAYNIGHT_CONSUMERS.every((c) => c.pattern.test(code));
}

/**
 * No day/night-family call site takes a mesh normal.
 *
 * `computeDayNightFade`, `computeDayNightDiffuse` and `computeTerminatorGlow`
 * each have exactly one call site; none may be handed `normal`, `normalEC`, or
 * `input.v_normalEC`. (`computeDayNightDiffuse` joined the family at CO-18,
 * when CLT-B4 split the single reused ramp function into the two expressions
 * WebGL has always had.)
 */
export function noMeshNormalInDayNightFamily(source) {
  const code = stripWgslComments(source);
  for (const fn of [
    "computeDayNightFade",
    "computeDayNightDiffuse",
    "computeTerminatorGlow",
  ]) {
    // The DEFINITION reads `fn NAME(`; a CALL SITE does not, so the lookbehind
    // separates them without a second pass.
    const re = new RegExp(`(?<!fn )\\b${fn}\\(([^)]*)\\)`, "g");
    const argLists = [];
    let m;
    // Bounded: every match consumes at least the function name, so `lastIndex`
    // strictly advances and the loop terminates in O(source length).
    while ((m = re.exec(code)) !== null) {
      argLists.push(m[1]);
    }
    // Exactly one call site is expected. Zero means the term was deleted;
    // more than one means a second consumer landed that this row never audited.
    if (argLists.length !== 1) {
      return false;
    }
    if (/\bnormalEC\b|\bnormal\b|input\.v_normalEC/.test(argLists[0])) {
      return false;
    }
  }
  return true;
}

// ─── A. the shader carries the new law ───────────────────────────────────────

test("A1: the analytic geocentric normal is derived once, per fragment", () => {
  assert.equal(
    derivesAnalyticNormal(wgsl),
    true,
    "`dayNightNormalEC` must be `normalize((modifiedModelView * vec4(normalize(v_positionMC), 0)).xyz)` — " +
      "the eye-space analytic geocentric normal, matching GlobeFS.glsl:595-597",
  );
});

test("A2: every day/night-family consumer takes it", () => {
  for (const { name, pattern } of DAYNIGHT_CONSUMERS) {
    assert.match(wgslCode, pattern, `${name} does not take dayNightNormalEC`);
  }
  assert.equal(consumersTakeAnalyticNormal(wgsl), true);
});

test("A3: no day/night-family call site takes the mesh normal", () => {
  assert.equal(
    noMeshNormalInDayNightFamily(wgsl),
    true,
    "a day/night term is reading `v_normalEC` again — on normal-less terrain " +
      "that is a CONSTANT and the whole term goes globally uniform",
  );
});

test("A4: the fix did NOT over-apply — mesh-normal terms keep the mesh normal", () => {
  // Over-application is as much a defect as under-application. These three
  // consumers are mesh-normal terms by WebGL's own law (or by having no WebGL
  // twin at all) and must be untouched by this row.

  // (i) ENABLE_VERTEX_LIGHTING's Lambert — WebGL's vertex-lighting arm really
  //     does read v_normalEC (GlobeFS.glsl, guarded by ENABLE_VERTEX_LIGHTING).
  assert.match(wgslCode, /let NdotL = max\(dot\(normal, sunDir\), 0\.0\);/);
  assert.match(wgslCode, /let lambertTerm = NdotL \* camera\.lighting\.x;/);

  // (ii) the G-buffer normal slot — it publishes the SURFACE normal, which is
  //      the mesh normal by definition.
  assert.match(wgslCode, /makeFragOutput\([^)]*normalEC\)/);

  // (iii) CSM slope bias — reads the mesh normal so the bias tracks real
  //       terrain slope.
  assert.match(
    wgslCode,
    /globeComputeShadowFactorCSM\(\s*input\.v_positionRTE,\s*viewDepth,\s*input\.v_normalEC,/,
  );

  // (iv) RECORDED, NOT ENFORCED AS DESIRABLE: `computeAtmosphereColor` still
  //      takes the mesh normal. It is a WGSL-only fog approximation using the
  //      normal purely as a view-angle reference; WebGL's fog path takes no
  //      surface normal, so there is no law to match and this row did not move
  //      it. It IS a second consumer of the same constant — if a future row
  //      fixes it, update this assertion and the DEFERRED_WORK note together.
  const atmosphereCalls =
    wgslCode.match(
      /computeAtmosphereColor\(\s*input\.v_positionEC, normal,/g,
    ) ?? [];
  assert.equal(
    atmosphereCalls.length,
    2,
    "computeAtmosphereColor's normal source moved — reconcile with the " +
      "NEW-WEBGPU-GLOBE-DAYNIGHT-NORMAL-SOURCE row's recorded scope",
  );
});

test("A5: the derivation sits ABOVE the enableLighting gate", () => {
  // Not cosmetic. `probe-daynight-terminator-law.mjs`'s lane C decides finding
  // (c)'s static half with
  //   /if \(camera\.enableLighting > 0\.5\) \{\s*\n\s*dayFade = computeDayNightFade/
  // so a `let` inserted between the brace and the assignment would silently
  // turn that lane's `webgpu_dayFadeGate` metric false and push a spurious
  // failure into an unrelated lane.
  assert.match(
    wgsl,
    /if \(camera\.enableLighting > 0\.5\) \{\s*\n\s*dayFade = computeDayNightFade/,
    "lane C's static gate regex no longer matches — the probe would report a " +
      "shape change that did not happen",
  );
  const derivation = wgsl.indexOf("let dayNightNormalEC = normalize(");
  const gate = wgsl.indexOf("if (camera.enableLighting > 0.5) {");
  assert.ok(derivation > 0 && gate > 0);
  assert.ok(derivation < gate, "the derivation must precede the gate");
});

// ─── B. WebGL's law, executed against WebGL's sources ────────────────────────

test("B1: the two WebGL lighting defines are mutually exclusive arms", () => {
  assert.match(
    shaderSetCode,
    /if\s*\(\s*enableLighting\s*\)\s*\{\s*if\s*\(\s*hasVertexNormals\s*\)\s*\{[\s\S]{0,240}?ENABLE_VERTEX_LIGHTING[\s\S]{0,240}?\}\s*else\s*\{[\s\S]{0,240}?ENABLE_DAYNIGHT_SHADING/,
    "GlobeSurfaceShaderSet.js:435-442 is the evidence for the per-terrain-kind " +
      "decision; if it changed, the decision must be re-derived",
  );
});

test("B2: WebGL's day/night term reads the ANALYTIC normal, per fragment", () => {
  assert.match(
    globeFs,
    /#if defined\(SHOW_REFLECTIVE_OCEAN\) \|\| defined\(ENABLE_DAYNIGHT_SHADING\) \|\| defined\(HDR\)\n\s*vec3 normalMC = czm_geodeticSurfaceNormal\(v_positionMC, vec3\(0\.0\), vec3\(1\.0\)\);[^\n]*\n\s*vec3 normalEC = czm_normal3D \* normalMC;/,
  );
  assert.match(
    globeFs,
    /#if defined\(APPLY_DAY_NIGHT_ALPHA\) && defined\(ENABLE_DAYNIGHT_SHADING\)\n\s*float nightBlend = 1\.0 - clamp\(czm_getLambertDiffuse\(czm_lightDirectionEC, normalEC\) \* 5\.0, 0\.0, 1\.0\);/,
    "the GLSL night blend must consume `normalEC` — the analytic one computed " +
      "two lines above, NOT a mesh varying",
  );
});

test("B3: WebGL's day/night path has no mesh normal available at all", () => {
  // `v_normalEC` is only WRITTEN under the vertex-lighting / material / GBuffer
  // defines. A shader compiled with ENABLE_DAYNIGHT_SHADING alone could not
  // read a mesh normal even if it wanted to — which is why "keep the mesh
  // normal for the day/night term" has no WebGL arm to point at.
  const guard =
    "#if defined(ENABLE_VERTEX_LIGHTING) || defined(GENERATE_POSITION_AND_NORMAL) || defined(APPLY_MATERIAL)";
  assert.match(
    globeVs,
    new RegExp(
      `${guard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]{0,400}?v_normalEC = czm_normal3D \\* v_normalMC;\\n#endif`,
    ),
  );
  // Exactly one write, and it is inside that guard — not merely "a guard with
  // those names exists somewhere".
  const writes = globeVs.match(/^\s*v_normalEC = /gm) ?? [];
  assert.equal(writes.length, 1, "v_normalEC gained a second writer");
  assert.ok(
    !guard.includes("ENABLE_DAYNIGHT_SHADING"),
    "the only guard that writes v_normalEC must have no day/night arm",
  );
  // GlobeVS DOES name ENABLE_DAYNIGHT_SHADING elsewhere (the atmosphere
  // lighting block at :310), so a file-wide absence check would be wrong; what
  // matters is that the day/night define never reaches the normal write.
  // Depth-aware slice: the guard's body nests an `#if defined(EXAGGERATION)`
  // block, so a naive scan to the first `#endif` stops short of the write.
  const vsLines = globeVs.split("\n");
  const start = vsLines.findIndex((l) => l.trim() === guard);
  assert.ok(start >= 0, "the v_normalEC guard was not found in GlobeVS");
  const body = [];
  let depth = 1;
  // Bounded by the file length; breaks as soon as the guard closes.
  for (let i = start + 1; i < vsLines.length && depth > 0; i++) {
    const trimmed = vsLines[i].trim();
    if (trimmed.startsWith("#if")) {
      depth += 1;
    } else if (trimmed.startsWith("#endif")) {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
    body.push(vsLines[i]);
  }
  assert.equal(depth, 0, "unbalanced #if/#endif around the v_normalEC guard");
  const block = body.join("\n");
  assert.ok(block.includes("v_normalEC = czm_normal3D * v_normalMC;"));
  assert.doesNotMatch(block, /ENABLE_DAYNIGHT_SHADING/);
});

test("B4: the per-terrain-kind table, in executable form", () => {
  // The decision this row made, stated as data and checked against B1-B3.
  const webglDayNightNormalSource = (hasVertexNormals) =>
    hasVertexNormals ? "term-absent" : "analytic";
  assert.equal(webglDayNightNormalSource(false), "analytic");
  assert.equal(webglDayNightNormalSource(true), "term-absent");
  // The mesh normal is never the answer, so "analytic on both kinds" is the
  // only WebGPU law that never contradicts WebGL on a kind where WebGL speaks.
  assert.ok(
    ![false, true].map(webglDayNightNormalSource).includes("mesh"),
    "if WebGL ever sources a mesh normal for the day/night term, this row's " +
      "unconditional choice must be revisited",
  );
});

// ─── C. the defect, executed ─────────────────────────────────────────────────

/** `octDecode`, transcribed from GlobeTerrain.wgsl. */
function octDecode(encoded) {
  const temp = encoded / 256.0;
  const x01 = Math.floor(temp) / 255.0;
  const fract = temp - Math.floor(temp);
  const y01 = (fract * 256.0) / 255.0;
  const v = [x01 * 2.0 - 1.0, y01 * 2.0 - 1.0];
  const vz = 1.0 - Math.abs(v[0]) - Math.abs(v[1]);
  let r;
  if (vz < 0.0) {
    const sx = v[0] >= 0.0 ? 1.0 : -1.0;
    const sy = v[1] >= 0.0 ? 1.0 : -1.0;
    r = [(1.0 - Math.abs(v[1])) * sx, (1.0 - Math.abs(v[0])) * sy, vz];
  } else {
    r = [v[0], v[1], vz];
  }
  const len = Math.hypot(r[0], r[1], r[2]);
  return r.map((c) => c / len);
}

test("C1: the transcription is anchored to the shader it models", () => {
  assert.match(
    wgslCode,
    /fn octDecode\(encoded: f32\) -> vec3<f32> \{\s*let temp = encoded \/ 256\.0;/,
  );
});

test("C2: both no-normal encodings decode to a CONSTANT spin-axis vector", () => {
  const zero = octDecode(0.0);
  assert.ok(Math.abs(zero[0]) < 1e-12 && Math.abs(zero[1]) < 1e-12);
  assert.ok(Math.abs(zero[2] + 1) < 1e-12, `octDecode(0) = ${zero}`);

  const filler = octDecode(32896.0);
  assert.ok(Math.abs(filler[0]) < 0.01 && Math.abs(filler[1]) < 0.01);
  assert.ok(filler[2] > 0.999, `octDecode(32896) = ${filler}`);
});

test("C3: the no-normal pipeline really does leave the slot at the default", () => {
  // `float32x2` over a 4-component shader-side declaration means `.z` reads the
  // WebGPU default 0.0 — which is what makes `octDecode(0.0)` reachable.
  assert.match(
    pipelinesCode,
    /} else \{\s*texCoordFormat = "float32x2";\s*entryPoint = "vertexMain";/,
    "the no-extras uncompressed layout is the default-terrain path; if its " +
      "vertex format changed, re-derive what `tc.z` holds",
  );
  assert.match(wgslCode, /return processVertex\(position, uv, 32896\.0,/);
});

test("C4: the constant-normal term is globally uniform; the analytic one is not", () => {
  // The fix's effect, arithmetic rather than assertion. Sample surface normals
  // over a sphere; evaluate the day fade with (i) the constant the mesh path
  // supplied and (ii) the true surface normal, at an equinox sun (equatorial).
  const dayFade = (ndotl) => Math.min(1, Math.max(0, ndotl * 5.0 + 0.5));
  const sun = [1, 0, 0]; // equatorial — the equinox framing lane A uses
  const constantN = octDecode(0.0); // (0, 0, -1)

  const constantValues = [];
  const analyticValues = [];
  // 24 x 24 = 576 directions. Bounded double loop, no early exit needed.
  for (let i = 0; i < 24; i++) {
    const lat = (-Math.PI / 2) * 0.98 + (i / 23) * Math.PI * 0.98;
    for (let j = 0; j < 24; j++) {
      const lon = (j / 24) * 2 * Math.PI;
      const n = [
        Math.cos(lat) * Math.cos(lon),
        Math.cos(lat) * Math.sin(lon),
        Math.sin(lat),
      ];
      constantValues.push(
        dayFade(
          constantN[0] * sun[0] + constantN[1] * sun[1] + constantN[2] * sun[2],
        ),
      );
      analyticValues.push(
        dayFade(n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]),
      );
    }
  }
  const range = (xs) => Math.max(...xs) - Math.min(...xs);
  assert.equal(
    range(constantValues),
    0,
    "precondition: the pre-fix term is provably constant across the globe",
  );
  assert.equal(
    constantValues[0],
    0.5,
    "and its value at the equinox is exactly the 0.5 the recorded +0.5 finding " +
      "predicts — which is why the terminator value alone could not decide",
  );
  assert.equal(
    range(analyticValues),
    1,
    "the post-fix term must span the full 0..1 day fade",
  );
});

// ─── D. MUTANTS — the pins must reject a source that puts the bug back ───────

/**
 * All mutation is IN MEMORY. No file is copied, written, or restored: a spec
 * that mutates on disk can leave the tree dirty if it throws mid-run.
 */
function mutate(source, from, to) {
  assert.ok(
    source.includes(from),
    `mutation precondition failed: "${from.slice(0, 60)}..." not present`,
  );
  return source.replace(from, to);
}

test("D1: reinstating v_normalEC for the day/night fade is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "dayFade = computeDayNightFade(dayNightNormalEC, sunDir);",
    "dayFade = computeDayNightFade(normal, sunDir);",
  );
  assert.equal(
    consumersTakeAnalyticNormal(mutant),
    false,
    "the consumer pin must fail on the pre-fix expression",
  );
  assert.equal(
    noMeshNormalInDayNightFamily(mutant),
    false,
    "the mesh-normal pin must fail on the pre-fix expression",
  );
});

test("D2: reinstating it for the terminator glow alone is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "        computeTerminatorGlow(dayNightNormalEC, sunDir) *",
    "        computeTerminatorGlow(normal, sunDir) *",
  );
  assert.equal(consumersTakeAnalyticNormal(mutant), false);
  assert.equal(noMeshNormalInDayNightFamily(mutant), false);
});

test("D3: reinstating it for the DAYNIGHT diffuse alone is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "let dayNightDiffuse = computeDayNightDiffuse(dayNightNormalEC, sunDir);",
    "let dayNightDiffuse = computeDayNightDiffuse(normal, sunDir);",
  );
  assert.equal(
    consumersTakeAnalyticNormal(mutant),
    false,
    "a diffuse term fed the mesh normal must not pass — it is the term WebGL " +
      "sources from the analytic normal",
  );
  assert.equal(
    noMeshNormalInDayNightFamily(mutant),
    false,
    "the mesh-normal pin must cover the CO-18 diffuse expression too",
  );
});

test("D4: deriving the normal but never consuming it is REJECTED", () => {
  // The failure mode a purely-existence-based pin would miss: scaffolding that
  // computes the right thing and throws it away.
  let mutant = wgsl;
  for (const [from, to] of [
    [
      "dayFade = computeDayNightFade(dayNightNormalEC, sunDir);",
      "dayFade = computeDayNightFade(normal, sunDir);",
    ],
    [
      "let dayNightDiffuse = computeDayNightDiffuse(dayNightNormalEC, sunDir);",
      "let dayNightDiffuse = computeDayNightDiffuse(normal, sunDir);",
    ],
    [
      "        computeTerminatorGlow(dayNightNormalEC, sunDir) *",
      "        computeTerminatorGlow(normal, sunDir) *",
    ],
  ]) {
    mutant = mutate(mutant, from, to);
  }
  assert.equal(
    derivesAnalyticNormal(mutant),
    true,
    "precondition: the derivation itself survives this mutation",
  );
  assert.equal(
    consumersTakeAnalyticNormal(mutant),
    false,
    "an unconsumed derivation must NOT satisfy the row",
  );
});

test("D5: dropping the derivation entirely is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "let dayNightNormalEC = normalize(",
    "let dayNightNormalECUnused = normalize(",
  );
  assert.equal(derivesAnalyticNormal(mutant), false);
});

test("D6: a WORLD-space normal (no view transform) is REJECTED", () => {
  // The tempting shortcut: `normalize(v_positionMC)` on its own. `sunDir` is
  // eye-space (`camera.sunDirectionEC`), so that dot product mixes frames and
  // the terminator would rotate with the camera.
  const mutant = mutate(
    wgsl,
    `let dayNightNormalEC = normalize(
    (camera.modifiedModelView *
      vec4<f32>(normalize(input.v_positionMC), 0.0)).xyz,
  );`,
    "let dayNightNormalEC = normalize(input.v_positionMC);",
  );
  assert.equal(
    derivesAnalyticNormal(mutant),
    false,
    "the derivation pin must require the eye-space transform, not just the " +
      "geocentric direction",
  );
});

// ─── E. what this row deliberately did NOT change ────────────────────────────

test("E1: the +0.5 ramp offset (CLT-B4) is GONE — closed at Batch 925, CO-18", () => {
  // This assertion is INVERTED from its original form. It used to pin that the
  // `+0.5` was still present, precisely so that removing it could not happen
  // quietly. It has now been removed deliberately; the pin flips rather than
  // being deleted, so a re-introduction is still caught.
  assert.doesNotMatch(
    wgslCode,
    /clamp\(\s*(?:NdotL|lambertDiffuse)\s*\*\s*5\.0\s*\+\s*0\.5\s*,\s*0\.0\s*,\s*1\.0\s*\)/,
    "the +0.5 ramp offset is back — CLT-B4 regressed",
  );
  assert.match(
    wgslCode,
    /fn computeDayNightFade\(normalEC: vec3<f32>, sunDirEC: vec3<f32>\) -> f32 \{\n\s*let lambertDiffuse = max\(dot\(sunDirEC, normalEC\), 0\.0\);\n\s*return clamp\(lambertDiffuse \* 5\.0, 0\.0, 1\.0\);/,
    "the WGSL day-fade law must be GLSL's `clamp(N·L*5, 0, 1)` — see " +
      "globe-daynight-ramp-law.spec.mjs for the full pair contract",
  );
  // The two backends' alpha ramps now agree at the geometric terminator.
  const glslLaw = (n) => Math.min(1, Math.max(0, n * 5.0));
  const wgslLaw = (n) => Math.min(1, Math.max(0, n * 5.0));
  assert.equal(wgslLaw(0) - glslLaw(0), 0);
});

test("E2: WebGPU still applies the ramp on vertex-normal terrain (finding (c))", () => {
  // The day/night gate reads `camera.enableLighting` only — there is no
  // `camera.lighting.z` (hasVertexNormals) arm on it, which is exactly the
  // divergence CLT-B1 finding (c) records and this row did not close.
  const gate =
    /var dayFade: f32;\s*var nightBlend: f32;\s*if \(camera\.enableLighting > 0\.5\) \{[\s\S]{0,200}?\n\s*\}/.exec(
      wgslCode,
    );
  assert.ok(gate, "the day/night gate block was not found");
  assert.doesNotMatch(
    gate[0],
    /camera\.lighting\.z/,
    "if a vertex-normal arm landed on the day/night gate, finding (c) is " +
      "resolved and the CLT plan must say so",
  );
});

// ─── F. the edit is define-set-independent, and naga still validates ─────────

/** `//>>ifdef` expansion, matching `WebGPUShaderPreprocessor`'s zero-mask law. */
function expandDefines(source, defines) {
  const active = new Set(defines);
  const out = [];
  const stack = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//>>ifdef")) {
      stack.push({ emitting: active.has(trimmed.split(/\s+/)[1]) });
      continue;
    }
    if (trimmed.startsWith("//>>else")) {
      const top = stack[stack.length - 1];
      top.emitting = !top.emitting;
      continue;
    }
    if (trimmed.startsWith("//>>endif")) {
      stack.pop();
      continue;
    }
    if (stack.every((frame) => frame.emitting)) {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** Every flag the shader actually branches on. */
const FLAGS = Object.freeze([
  "CAPTURE_MODE",
  "ENHANCED_OCEAN",
  "GEODETIC_NORMAL",
  "GLOBE_IMAGERY_REDUCED",
  "LOG_DEPTH",
  "MATERIAL_APPLY",
]);

/** Lines this row edited — the ones every define set must be shown to carry. */
const EDITED_MARKERS = Object.freeze([
  "let dayNightNormalEC = normalize(",
  "dayFade = computeDayNightFade(dayNightNormalEC, sunDir);",
  "let dayNightDiffuse = computeDayNightDiffuse(dayNightNormalEC, sunDir);",
  "computeTerminatorGlow(dayNightNormalEC, sunDir) *",
]);

test("F1: the flag list is complete — no directive uses a flag not listed", () => {
  const used = new Set(
    (wgsl.match(/^\s*\/\/>>ifdef\s+([A-Z_]+)/gm) ?? []).map(
      (l) => l.trim().split(/\s+/)[1],
    ),
  );
  for (const flag of used) {
    assert.ok(
      FLAGS.includes(flag),
      `${flag} branches the shader but is not in this spec's FLAGS list — the ` +
        "define-set sweep below would not cover it",
    );
  }
  assert.equal(used.size, FLAGS.length, `flags in use: ${[...used].join(",")}`);
});

test("F2: every edited line sits at `//>>ifdef` depth 0", () => {
  // This is what makes ONE reading of the source a statement about EVERY define
  // set: no `//>>else` arm was rewritten, so the preprocessor emits the same
  // text for the edited region under every mask.
  const lines = wgsl.split("\n");
  let depth = 0;
  const depthOf = new Map();
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//>>ifdef")) {
      depth += 1;
      return;
    }
    if (trimmed.startsWith("//>>endif")) {
      depth -= 1;
      return;
    }
    if (trimmed.startsWith("//>>else")) {
      return;
    }
    depthOf.set(index, depth);
  });
  assert.equal(depth, 0, "unbalanced `//>>ifdef` / `//>>endif` in the shader");
  for (const marker of EDITED_MARKERS) {
    const index = lines.findIndex((l) => l.includes(marker));
    assert.ok(index >= 0, `edited line not found: ${marker}`);
    assert.equal(
      depthOf.get(index),
      0,
      `"${marker}" is inside a //>>ifdef block — the define-set argument would ` +
        "need a per-mask reading, not a single one",
    );
  }
});

test("F3: all 64 define sets carry the edit and produce no live directive", () => {
  // Bounded: 2^6 = 64 subsets of a frozen 6-element list.
  assert.equal(FLAGS.length, 6);
  for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
    const defines = FLAGS.filter((_, bit) => (mask & (1 << bit)) !== 0);
    const text = expandDefines(wgsl, defines);
    for (const marker of EDITED_MARKERS) {
      assert.ok(
        text.includes(marker),
        `"${marker}" vanished under [${defines.join(",")}]`,
      );
    }
    const live = text.split("\n").filter((l) => l.trim().startsWith("//>>"));
    assert.equal(
      live.length,
      0,
      `a directive survived preprocessing under [${defines.join(",")}]`,
    );
  }
});

test("F4: naga validates the edited shader across the define-set sweep", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  // MATERIAL_APPLY is EXCLUDED, and not for convenience: its arm calls
  // `czm_getMaterial`, which the material codegen injects at pipeline-build
  // time and which therefore does not exist in the source module. naga rejects
  // that expansion at HEAD too — it is a property of the material pipeline, not
  // of this row's edit. The other five flags are self-contained.
  const validatable = FLAGS.filter((f) => f !== "MATERIAL_APPLY");
  // The whole power set would be 64 full validations of a 5.4k-line module.
  // The empty set, every singleton, and the all-on set bracket it: the edited
  // region is at depth 0 (F2) and present in all 64 (F3), so what remains to
  // check is that no flag's OWN arm stopped compiling next to the new `let`.
  const sets = [[], ...validatable.map((f) => [f]), validatable.slice()];
  for (const defines of sets) {
    const text = expandDefines(wgsl, defines);
    assert.doesNotThrow(
      () => naga.validate_wgsl(text),
      `naga rejected the module under [${defines.join(",") || "none"}]`,
    );
  }
});
