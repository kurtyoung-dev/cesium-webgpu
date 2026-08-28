// globe-night-darkness-fallback.spec.mjs
// @purpose Pins the procedural night-side darkening: one law on both backends, applied only where no night imagery layer is blending, with no camera-distance fade, and inert at its identity default.
// @status ACTIVE
//
// THE BEHAVIOUR, STATED WITHOUT REFERENCE TO ANY IMPLEMENTATION SHAPE.
//
//   A globe with no night imagery renders its night side as brightly as its
//   day side. The fallback scales the composited surface toward a configurable
//   floor as the sun goes below the horizon, and does nothing at all when that
//   floor is 1.0 — which is the default, so a scene that never asked for the
//   feature is unchanged.
//
// Three properties carry the whole row, and each fails differently:
//
//   • WHICH SIDE. Darkening must follow the night fraction. Applied to the
//     complement it darkens the sunlit hemisphere, which is a plausible typo
//     and a catastrophic one; a deletion mutant does not find it.
//   • WHERE IT RUNS. It is a FALLBACK, and its share is the share of the night
//     side the imagery leaves uncovered. Where a night layer covers the tile's
//     night side completely — the Black Marble pyramid at its own resolution,
//     or any layer with a day/night alpha pair at full night opacity — the
//     night appearance comes from that layer and darkening the composite again
//     dims the city lights, so the fallback scales to the multiplicative
//     identity and its define never fires. Where the layer covers none of it —
//     no day/night layer at all, or one the magnification fade has retired
//     below the deepest level its pyramid contains — the full darkness applies.
//     Partial coverage is the continuous interpolation of those two, so the two
//     mechanisms hand over without a step at the boundary, and both backends
//     must read the SAME scaled scalar rather than each conjoining its own
//     pair. The boolean suppression this row shipped with survives exactly as
//     the two endpoints of that scale.
//   • HOW FAR. The day/night DIFFUSE is mixed toward full brightness by a
//     camera-distance fade, so a globe seen from the ground is flat-lit; that
//     is upstream's behaviour and this row does not touch it. The fallback
//     deliberately has no such fade — being dark at street altitude is the
//     point of it — so the two terms must not share a mix.
//
// WHAT THIS SPEC IS FOR. It EXECUTES the darkening law read out of both shader
// sources rather than describing it, so "the night side gets darker" is checked
// as a number. It owns neither the dusk ramp (globe-daynight-ramp-law) nor the
// gate that decides when the ramp runs (globe-daynight-alpha-gate); it owns the
// term the ramp now feeds and the conjunction that arms it.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read is normalised to
// `\n` first — a spec anchored on a bare `\n` false-greens on a CRLF checkout.
//
// Run: node --test Tools/visual-regression/globe-night-darkness-fallback.spec.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

const WGSL_PATH =
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const GLSL_PATH = "packages/engine/Source/Shaders/GlobeFS.glsl";
const TILE_UB_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts";
const TYPES_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts";
const SHADER_SET_PATH = "packages/engine/Source/Scene/GlobeSurfaceShaderSet.js";
const TILE_RENDERING_PATH =
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js";
const GLOBE_PATH = "packages/engine/Source/Scene/Globe.js";
const TILE_PROVIDER_PATH =
  "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js";

const wgsl = read(WGSL_PATH);
const glsl = read(GLSL_PATH);
const tileUb = read(TILE_UB_PATH);
const types = read(TYPES_PATH);
const shaderSet = read(SHADER_SET_PATH);
const tileRendering = read(TILE_RENDERING_PATH);
const globe = read(GLOBE_PATH);
const tileProvider = read(TILE_PROVIDER_PATH);

/** Strip line comments so prose can never satisfy a pin. */
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const wgslCode = stripLineComments(wgsl);
const glslCode = stripLineComments(glsl);

// ─── the law, read OUT of the sources rather than restated ───────────────────

const WGSL_TERM_RE =
  /color = color \* mix\(1\.0, tile\.hsbShift\.w, ([^);]+)\);/;
const GLSL_TERM_RE = /color\.rgb \*= mix\(1\.0, u_nightDarkness, ([^);]+)\);/;

/** The shared dusk ramp's night fraction. Owned by globe-daynight-ramp-law. */
function nightBlend(ndotl) {
  const lambert = ndotl > 0 ? ndotl : 0;
  const day = Math.min(1, Math.max(0, lambert * 5));
  return 1 - day;
}

/**
 * Turn a captured third argument of `mix` into a function of the night
 * fraction. Only two spellings are recognised, and that is the point: the
 * wrong-side mutant writes the other one, and anything a reader would have to
 * guess at fails the pin loudly instead of being waved through.
 */
function blendArgument(expression) {
  const text = expression.trim();
  if (text === "nightBlend") {
    return (blend) => blend;
  }
  if (text === "1.0 - nightBlend") {
    return (blend) => 1 - blend;
  }
  return undefined;
}

/** The multiplier a source's own term applies, as a function of N·L. */
function multiplierFrom(source, regex, darkness) {
  const match = regex.exec(stripLineComments(source));
  assert.ok(match, "the darkening term was not found in its source");
  const argument = blendArgument(match[1]);
  assert.ok(argument, `unrecognised blend argument: ${match[1]}`);
  return (ndotl) => 1 + (darkness - 1) * argument(nightBlend(ndotl));
}

/**
 * `mix(a, b, t)` is `a + (b - a) * t` on both backends, so the floor is
 * reproduced to within one double rounding rather than bit-exactly. The
 * tolerance is far below any 8-bit framebuffer step and far above the error.
 */
const EPSILON = 1e-12;

function assertClose(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `${message}: ${actual} !== ${expected}`,
  );
}

/** 41 samples across the full N·L range. Bounded. */
const GRID = Object.freeze(Array.from({ length: 41 }, (_, i) => -1 + i * 0.05));

// ─── A. the law, executed ────────────────────────────────────────────────────

test("A1: the WGSL term darkens the NIGHT side and leaves daylight alone", () => {
  const m = multiplierFrom(wgsl, WGSL_TERM_RE, 0.15);
  assertClose(m(-1), 0.15, "deep night takes the floor");
  assertClose(m(0), 0.15, "at the geometric terminator it is still full night");
  assertClose(m(0.2), 1, "the ramp saturates to full day at N·L = 0.2");
  assertClose(m(1), 1, "subsolar is untouched");
});

test("A2: the GLSL term is the same function of N·L", () => {
  const w = multiplierFrom(wgsl, WGSL_TERM_RE, 0.15);
  const g = multiplierFrom(glsl, GLSL_TERM_RE, 0.15);
  let worst = 0;
  for (const ndotl of GRID) {
    worst = Math.max(worst, Math.abs(w(ndotl) - g(ndotl)));
  }
  assert.equal(worst, 0, "the two backends must darken by the same factor");
});

test("A3: it is monotone across dusk — no band, no reversal", () => {
  const m = multiplierFrom(wgsl, WGSL_TERM_RE, 0.15);
  let previous = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const v = m(i * 0.01);
    assert.ok(
      v >= previous,
      "the surface must brighten monotonically into day",
    );
    previous = v;
  }
});

test("A4: the default value is the exact multiplicative identity", () => {
  // This is the byte-identity guarantee, expressed as arithmetic: at the
  // documented default no N·L produces a factor other than 1, so a scene that
  // never set the property cannot change colour even if the term were live.
  const m = multiplierFrom(wgsl, WGSL_TERM_RE, 1.0);
  for (const ndotl of GRID) {
    // Exact, not approximate: `a + (b - a) * t` with a === b is `a + 0 * t`,
    // which is `a` for every finite t in IEEE 754. That is what makes the
    // default path byte-identical rather than merely close.
    assert.equal(m(ndotl), 1, `identity must hold at N·L = ${ndotl}`);
  }
  assert.match(
    globe,
    /this\.nightDarkness = 1\.0;/,
    "Globe must default the property to the identity",
  );
  assert.match(
    tileProvider,
    /this\.nightDarkness = 1\.0;/,
    "and so must the backend-neutral per-frame mirror",
  );
});

test("A5: a WRONG-SIDE term is a different function, so the law can detect it", () => {
  // The discriminator for mutants E4 and E6. If the two laws agreed anywhere
  // that mattered, those mutants would survive.
  const right = multiplierFrom(wgsl, WGSL_TERM_RE, 0.15);
  const wrong = (ndotl) => 1 + (0.15 - 1) * (1 - nightBlend(ndotl));
  assertClose(right(-1), 0.15, "the right term darkens deep night");
  assertClose(
    wrong(-1),
    1,
    "the wrong side leaves deep night at full brightness",
  );
  assertClose(right(1), 1, "the right term spares the subsolar point");
  assertClose(wrong(1), 0.15, "and the wrong side blackens it");
});

// ─── B. both backends apply it at the same point in the product ──────────────

test("B1: WGSL applies it ahead of the lighting branch and the glow ADD", () => {
  const term = wgslCode.indexOf("color = color * mix(1.0, tile.hsbShift.w,");
  const lighting = wgslCode.indexOf("if (camera.enableLighting > 0.5) {");
  const glow = wgslCode.indexOf(
    "computeTerminatorGlow(dayNightNormalEC, sunDir)",
  );
  assert.ok(term > 0 && lighting > 0 && glow > 0);
  assert.ok(term < lighting, "the term must precede the lighting branch");
  assert.ok(
    term < glow,
    "the terminator glow is an ADD of scattered light and must not be dimmed " +
      "by ground albedo",
  );
});

test("B2: GLSL applies it ahead of the three lighting arms and its own glow", () => {
  const term = glslCode.indexOf("color.rgb *= mix(1.0, u_nightDarkness,");
  const arms = glslCode.indexOf(
    "#ifdef ENABLE_VERTEX_LIGHTING\n    float diffuseIntensity",
  );
  const glow = glslCode.indexOf("computeTerminatorGlow(terminatorNormalEC");
  assert.ok(term > 0 && arms > 0 && glow > 0);
  assert.ok(term < arms, "the term must precede the lighting arms");
  assert.ok(term < glow, "and the additive glow");
});

test("B3: neither backend mixes the fallback with the camera-distance fade", () => {
  // The whole point of the row: the night side stays dark at street altitude.
  // `lightingFade` is what flat-lights the DIFFUSE near the ground, and it must
  // not reach this term.
  const wgslTerm = WGSL_TERM_RE.exec(wgslCode);
  const glslTerm = GLSL_TERM_RE.exec(glslCode);
  assert.ok(wgslTerm && glslTerm);
  assert.doesNotMatch(wgslTerm[0], /lightingFade/);
  assert.doesNotMatch(glslTerm[0], /u_dayNightFade|fade/);
  // And the diffuse still has it, so the two really are separate terms.
  assert.match(
    wgslCode,
    /diffuse = mix\(\s*1\.0,\s*dayNightDiffuse,\s*clamp\(tile\.lightingFade, 0\.0, 1\.0\),?\s*\);/,
  );
  assert.match(
    glslCode,
    /diffuseIntensity = mix\(1\.0, diffuseIntensity, fade\);/,
  );
});

test("B4: the WGSL scalar rides the HSB pad, and the tile buffer did not grow", () => {
  assert.match(types, /export const HSB_SHIFT_OFFSET = 468;/);
  assert.match(
    types,
    /export const TILE_UNIFORM_FLOATS = 492;/,
    "an alignment pad was reused, so no offset after it may move",
  );
  assert.doesNotMatch(
    tileUb,
    /data\[HSB_SHIFT_OFFSET \+ 3\] = 0;/,
    "the pad must no longer be hard-zeroed",
  );
  assert.match(
    wgslCode,
    /hsbShift: vec4<f32>,/,
    "the member itself is unchanged; only its fourth scalar acquired meaning",
  );
});

// ─── C. the arming conjunction, same two inputs on both backends ─────────────

/**
 * The scaled darkness both packs compute, transcribed; C1 and C2 pin the
 * transcription against each source. `coverage` is the largest night-side
 * opacity any day/night layer resolves to on the tile.
 */
function effectiveDarkness(darkness, coverage) {
  return 1.0 + (darkness - 1.0) * (1.0 - Math.min(Math.max(coverage, 0), 1));
}

/** WebGL arms its compile-time define off that one number. */
function webglArmed(darkness, coverage) {
  return effectiveDarkness(darkness, coverage) < 1.0;
}

/**
 * WebGPU's, likewise. The float round trip is deliberate: the scalar reaches
 * the shader packed into a Float32Array slot and is read back with the same
 * threshold, so this is the comparison the GPU actually performs.
 */
function webgpuArmed(darkness, coverage) {
  const packed = Math.fround(effectiveDarkness(darkness, coverage));
  return packed < 1.0;
}

test("C1: WebGL scales the darkness by the uncovered share and arms off that", () => {
  assert.match(
    tileRendering,
    /const effectiveNightDarkness =\s*1\.0 \+\s*\(nightDarkness - 1\.0\) \*\s*\(1\.0 - CesiumMath\.clamp\(nightLayerCoverage, 0\.0, 1\.0\)\);/,
    "the fallback supplies what the layers leave uncovered",
  );
  assert.match(
    tileRendering,
    /uniformMapProperties\.nightDarkness = effectiveNightDarkness;\s*surfaceShaderSetOptions\.applyNightDarkness = effectiveNightDarkness < 1\.0;/,
    "the uniform the shader multiplies by and the define that gates it must " +
      "come from the one number, or a tile can be armed on a value it will " +
      "not receive",
  );
  assert.match(
    shaderSet,
    /if \(applyNightDarkness\) \{\s*fs\.defines\.push\("APPLY_NIGHT_DARKNESS"\);\s*\}/,
  );
});

test("C2: WGSL reads the same scaled scalar, with no second input of its own", () => {
  assert.match(
    wgslCode,
    /if \(tile\.hsbShift\.w < 1\.0\) \{\n\s*color = color \* mix\(1\.0, tile\.hsbShift\.w, nightBlend\);\n\s*\}/,
    "the coverage is folded into the packed scalar on the CPU, so the shader " +
      "guard is the same `< 1.0` test WebGL's define is derived from",
  );
  assert.doesNotMatch(
    wgslCode,
    /tile\.hsbShift\.w < 1\.0 && tile\.tileControls\.w/,
    "re-conjoining the day/night-alpha flag here would shut the fallback on " +
      "every tile a faded night layer still marks, which is the defect the " +
      "scaling exists to close",
  );
  assert.match(
    tileUb,
    /data\[HSB_SHIFT_OFFSET \+ 3\] =\s*1\.0 \+\s*\(sanitizedNightDarkness - 1\.0\) \*\s*\(1\.0 - Math\.min\(Math\.max\(nightLayerCoverage, 0\.0\), 1\.0\)\);/,
  );
});

test("C3: the two derivations agree over the whole input space", () => {
  const coverages = [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1, 1.5, -0.5];
  for (const darkness of [0, 0.15, 0.5, 0.999, 1, 1.0]) {
    for (const coverage of coverages) {
      assert.equal(
        webglArmed(darkness, coverage),
        webgpuArmed(darkness, coverage),
        `backends disagree at darkness=${darkness} coverage=${coverage}`,
      );
    }
  }
  // The boolean law this row shipped with is the two endpoints, unchanged.
  assert.equal(webglArmed(0.15, 0), true, "no coverage, darkness set: armed");
  assert.equal(
    webglArmed(0.15, 1),
    false,
    "a layer covering the night side suppresses it",
  );
  assert.equal(webglArmed(1.0, 0), false, "the identity arms nothing");
  assert.equal(webglArmed(1.0, 1), false);
  // And the middle is a genuine interpolation rather than a rounded endpoint,
  // which is what removes the step at the fade boundary.
  assertClose(effectiveDarkness(0.15, 0.5), 0.575, "half covered, half dark");
  assertClose(effectiveDarkness(0.0, 0.75), 0.75, "a quarter uncovered");
  // Monotone in coverage: more layer, less fallback, with no reversal.
  let previous = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const value = effectiveDarkness(0.15, i * 0.05);
    assert.ok(value >= previous, "the handover must not reverse");
    previous = value;
  }
});

test("C4: the new shader-set flag bit collides with nothing", () => {
  // The key is a sum of disjoint powers of two above bit 31 and a bitwise OR
  // below it. A reused value silently aliases two shader variants.
  const highFlags = [
    ...shaderSet.matchAll(/\?\s*(0x[0-9a-f]+)\s*:\s*0\)/g),
  ].map((m) => Number(m[1]));
  assert.ok(highFlags.length >= 4, "the high-flag list was not found");
  assert.equal(
    new Set(highFlags).size,
    highFlags.length,
    `duplicate high flag: ${highFlags.map((f) => f.toString(16)).join(",")}`,
  );
  assert.ok(
    highFlags.includes(0x800000000),
    "the night-darkness flag must be one of them",
  );
  for (const flag of highFlags) {
    assert.equal(
      Math.log2(flag) % 1,
      0,
      `high flag ${flag.toString(16)} is not a single bit`,
    );
    assert.ok(flag > 0xffffffff, "high flags must sit above the 32-bit OR");
  }
});

// ─── D. the default path is untouched ────────────────────────────────────────

test("D1: the GLSL term and its uniform live behind the define", () => {
  // A term outside the define would cost every default globe an analytic normal
  // and a mix, and would change the generated source for scenes that never
  // asked for the feature.
  assert.match(
    glslCode,
    /#ifdef APPLY_NIGHT_DARKNESS\n\s*color\.rgb \*= mix\(1\.0, u_nightDarkness, nightBlend\);\n#endif/,
  );
  assert.match(
    glslCode,
    /#ifdef APPLY_NIGHT_DARKNESS\nuniform float u_nightDarkness;\n#endif/,
  );
});

test("D2: the WebGPU pack writes the identity for a provider that has no property", () => {
  assert.match(
    tileUb,
    /typeof nightDarkness === "number" && Number\.isFinite\(nightDarkness\)\s*\?\s*Math\.min\(Math\.max\(nightDarkness, 0\.0\), 1\.0\)\s*:\s*1\.0;/,
    "a missing or non-finite value must resolve to the identity, not to zero",
  );
});

test("D3: Globe sanitizes the same way before the mirror is read", () => {
  assert.match(
    globe,
    /tileProvider\.nightDarkness =\s*typeof nightDarkness === "number" && Number\.isFinite\(nightDarkness\)\s*\?\s*CesiumMath\.clamp\(nightDarkness, 0\.0, 1\.0\)\s*:\s*1\.0;/,
  );
});

// ─── E. MUTANTS — absence, inertness, and the wrong side ─────────────────────

/** All mutation is IN MEMORY. No file is written, so a throw leaves no mess. */
function mutate(source, from, to) {
  assert.ok(
    source.includes(from),
    `mutation precondition failed: "${from.slice(0, 70)}..." not present`,
  );
  return source.replace(from, to);
}

/** The predicates under test, as functions of a source. */
function wgslTermIsLive(source) {
  const code = stripLineComments(source);
  return (
    /if \(tile\.hsbShift\.w < 1\.0\) \{\n\s*color = color \* mix\(1\.0, tile\.hsbShift\.w, nightBlend\);\n\s*\}/.test(
      code,
    ) && lawDarkensNight(source, WGSL_TERM_RE)
  );
}
function glslTermIsLive(source) {
  const code = stripLineComments(source);
  return (
    /#ifdef APPLY_NIGHT_DARKNESS\n\s*color\.rgb \*= mix\(1\.0, u_nightDarkness, nightBlend\);\n#endif/.test(
      code,
    ) && lawDarkensNight(source, GLSL_TERM_RE)
  );
}
/** Executed, not matched: the term must darken the night and spare the day. */
function lawDarkensNight(source, regex) {
  const match = regex.exec(stripLineComments(source));
  if (!match) {
    return false;
  }
  const argument = blendArgument(match[1]);
  if (!argument) {
    return false;
  }
  const m = (ndotl) => 1 + (0.15 - 1) * argument(nightBlend(ndotl));
  return Math.abs(m(-1) - 0.15) <= EPSILON && Math.abs(m(1) - 1) <= EPSILON;
}
function defineIsReachable(renderingSource) {
  return /surfaceShaderSetOptions\.applyNightDarkness = effectiveNightDarkness < 1\.0;/.test(
    renderingSource,
  );
}
function packIsLive(tileUbSource) {
  return (
    /const sanitizedNightDarkness =\s*typeof nightDarkness === "number"/.test(
      tileUbSource,
    ) &&
    /data\[HSB_SHIFT_OFFSET \+ 3\] =\s*1\.0 \+\s*\(sanitizedNightDarkness - 1\.0\) \*/.test(
      tileUbSource,
    ) &&
    !/data\[HSB_SHIFT_OFFSET \+ 3\] = 1\.0;/.test(tileUbSource)
  );
}
/**
 * The suppression half of the law, on each backend: a coverage term that can
 * never be anything but zero leaves the fallback darkening a night side a layer
 * is already painting, which is the double darkening this row exists to avoid.
 * Absence mutants do not find it — every symbol is still present.
 */
function coverageIsLive(renderingSource, tileUbSource) {
  return (
    /\(1\.0 - CesiumMath\.clamp\(nightLayerCoverage, 0\.0, 1\.0\)\)/.test(
      renderingSource,
    ) &&
    /nightLayerCoverage = Math\.max\(/.test(renderingSource) &&
    /\(1\.0 - Math\.min\(Math\.max\(nightLayerCoverage, 0\.0\), 1\.0\)\)/.test(
      tileUbSource,
    ) &&
    /if \(nightSideOpacity > nightLayerCoverage\) \{/.test(tileUbSource)
  );
}

test("E1: ABSENCE — deleting the WGSL multiply is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "    color = color * mix(1.0, tile.hsbShift.w, nightBlend);\n",
    "",
  );
  assert.equal(wgslTermIsLive(mutant), false);
});

test("E2: INERTNESS — a WGSL guard that can never open is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "if (tile.hsbShift.w < 1.0) {",
    "if (false && tile.hsbShift.w < 1.0) {",
  );
  assert.equal(wgslTermIsLive(mutant), false);
});

test("E3: INERTNESS — a WGSL multiply whose result is discarded is REJECTED", () => {
  // The failure a deletion mutant cannot see: every symbol present, the ramp
  // evaluated, the product formed and thrown away.
  const mutant = mutate(
    wgsl,
    "    color = color * mix(1.0, tile.hsbShift.w, nightBlend);",
    "    let unusedNightDarken = color * mix(1.0, tile.hsbShift.w, nightBlend);",
  );
  assert.equal(wgslTermIsLive(mutant), false);
});

test("E4: WRONG SIDE — a WGSL term on the day side is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "color = color * mix(1.0, tile.hsbShift.w, nightBlend);",
    "color = color * mix(1.0, tile.hsbShift.w, 1.0 - nightBlend);",
  );
  assert.equal(
    wgslTermIsLive(mutant),
    false,
    "a term that blackens the sunlit hemisphere must not pass",
  );
});

test("E5: ABSENCE — deleting the GLSL multiply is REJECTED", () => {
  const mutant = mutate(
    glsl,
    "    color.rgb *= mix(1.0, u_nightDarkness, nightBlend);\n",
    "",
  );
  assert.equal(glslTermIsLive(mutant), false);
});

test("E6: WRONG SIDE — a GLSL term on the day side is REJECTED", () => {
  const mutant = mutate(
    glsl,
    "color.rgb *= mix(1.0, u_nightDarkness, nightBlend);",
    "color.rgb *= mix(1.0, u_nightDarkness, 1.0 - nightBlend);",
  );
  assert.equal(glslTermIsLive(mutant), false);
});

test("E7: INERTNESS — a define that is derived but never true is REJECTED", () => {
  const mutant = mutate(
    tileRendering,
    "    surfaceShaderSetOptions.applyNightDarkness = effectiveNightDarkness < 1.0;",
    "    surfaceShaderSetOptions.applyNightDarkness = false;",
  );
  assert.equal(defineIsReachable(mutant), false);
});

test("E8: INERTNESS — a pack pinned at the identity is REJECTED", () => {
  // The WebGPU twin of E7: the slot is written, the shader reads it, and it can
  // never be anything but the identity, so the feature is dead on that backend
  // while every symbol is present.
  const mutant = mutate(
    tileUb,
    `  data[HSB_SHIFT_OFFSET + 3] =
    1.0 +
    (sanitizedNightDarkness - 1.0) *
      (1.0 - Math.min(Math.max(nightLayerCoverage, 0.0), 1.0));`,
    "  data[HSB_SHIFT_OFFSET + 3] = 1.0;",
  );
  assert.equal(packIsLive(mutant), false);
});

test("E8a: INERTNESS — a WebGL coverage term pinned at zero is REJECTED", () => {
  // The suppression half, which absence mutants cannot reach: the scale is
  // still computed, the define still derived, and every tile with a night
  // layer is darkened a second time on top of the layer's own city lights.
  const mutant = mutate(
    tileRendering,
    "(1.0 - CesiumMath.clamp(nightLayerCoverage, 0.0, 1.0));",
    "(1.0 - CesiumMath.clamp(0.0, 0.0, 1.0));",
  );
  assert.equal(coverageIsLive(mutant, tileUb), false);
});

test("E8b: INERTNESS — a WebGPU coverage term pinned at zero is REJECTED", () => {
  const mutant = mutate(
    tileUb,
    "(1.0 - Math.min(Math.max(nightLayerCoverage, 0.0), 1.0));",
    "(1.0 - Math.min(Math.max(0.0, 0.0), 1.0));",
  );
  assert.equal(coverageIsLive(tileRendering, mutant), false);
});

test("E8c: INERTNESS — a coverage accumulator that never rises is REJECTED", () => {
  // The other end of the same failure: the term is read, but nothing ever
  // writes it, so a covering layer never suppresses anything.
  const webgl = mutate(
    tileRendering,
    "        nightLayerCoverage = Math.max(",
    "        nightLayerCoverage = Math.min(",
  );
  assert.equal(coverageIsLive(webgl, tileUb), false);
  const webgpu = mutate(
    tileUb,
    "if (nightSideOpacity > nightLayerCoverage) {",
    "if (false && nightSideOpacity > nightLayerCoverage) {",
  );
  assert.equal(coverageIsLive(tileRendering, webgpu), false);
});

test("E9: the mutants are DISCRIMINATING — the real sources pass every predicate", () => {
  assert.equal(wgslTermIsLive(wgsl), true);
  assert.equal(glslTermIsLive(glsl), true);
  assert.equal(defineIsReachable(tileRendering), true);
  assert.equal(packIsLive(tileUb), true);
  assert.equal(coverageIsLive(tileRendering, tileUb), true);
});

test("E10: no source file was written — every mutation was in memory", () => {
  // Cheap, and it is the difference between a spec that leaves the tree clean
  // and one that leaves a mutant behind on a throw.
  for (const [relativePath, original] of [
    [WGSL_PATH, wgsl],
    [GLSL_PATH, glsl],
    [TILE_UB_PATH, tileUb],
    [TILE_RENDERING_PATH, tileRendering],
  ]) {
    const now = read(relativePath);
    assert.equal(
      crypto.createHash("sha256").update(now).digest("hex"),
      crypto.createHash("sha256").update(original).digest("hex"),
      `${relativePath} changed under the spec`,
    );
  }
});
