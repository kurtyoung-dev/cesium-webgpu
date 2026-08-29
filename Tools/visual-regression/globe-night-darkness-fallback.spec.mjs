// globe-night-darkness-fallback.spec.mjs
// @purpose Pins the procedural night-side darkening: one law on both backends, applied only where no night imagery layer is blending, with no camera-distance fade, and inert at its identity default.
// @status ACTIVE
//
// THE BEHAVIOUR, STATED WITHOUT REFERENCE TO ANY IMPLEMENTATION SHAPE.
//
//   A globe with no night imagery renders its night side as brightly as its
//   day side. The fallback scales the composited surface toward a configurable
//   floor as the sun goes below the horizon, and does nothing at all when that
//   floor is 1.0.
//
//   WHICH floor a scene gets by default is the fourth property below, and it is
//   the one that moved. The floor is no longer 1.0 unconditionally: this fork
//   ships a dark night side, and the identity is what an application gets back
//   when it declines the fork's night appearance outright.
//
// Four properties carry the whole row, and each fails differently:
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
//     must resolve the SAME share rather than each conjoining its own pair. The
//     boolean suppression this row shipped with survives exactly as the two
//     endpoints of that scale.
//
//     The share is resolved per FRAGMENT, in the shader, while the layers
//     composite - not folded into the packed floor on the CPU. The
//     magnification fade that produces it is itself a per-fragment weight, and
//     a share folded from a single tile's texel count steps across a terrain
//     LOD seam where the magnification does not, which shows as hard-edged
//     bands of differently-darkened tiles. So what the packers send is the
//     floor, and what the shaders resolve is the share.
//   • HOW FAR. The day/night DIFFUSE is mixed toward full brightness by a
//     camera-distance fade, so a globe seen from the ground is flat-lit; that
//     is upstream's behaviour and this row does not touch it. The fallback
//     deliberately has no such fade — being dark at street altitude is the
//     point of it — so the two terms must not share a mix.
//   • WHOSE CHOICE IT IS. An assigned value is the application's and applies
//     wherever it is set, including on a globe with no night imagery at all —
//     the configuration the property was added for — so a default that
//     swallowed it would be a silent no-op of an explicit request. An
//     unassigned value is the fork's, and the fork darkens only while its own
//     night appearance is in play: nightImagery set to false says the
//     application wants upstream's globe, and it must get upstream's globe
//     exactly rather than a procedurally darkened one. Nothing weaker counts as
//     declining — an application that merely builds its own imagery stack, and
//     so is never injected into, has said nothing about the night side.
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
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NIGHT_DARKNESS_DEFAULT,
  NIGHT_DARKNESS_IDENTITY,
  NightImagerySource,
  resolveNightDarkness,
  resolveNightImageryRequest,
} from "../../packages/engine/Source/Scene/GlobeNightImagery.js";
import { compileFunction } from "./lib/wgsl-mini-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

/**
 * The two line endings, spelled from character codes.
 *
 * Section F writes a source file back to disk, and this tree is CRLF. A needle
 * written with bare newlines cannot match a CRLF file, so a mutation that
 * missed its target would report a green it never earned.
 */
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
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
  /color = color \* mix\(1\.0, effectiveNightDarkness, ([^);]+)\);/;
const GLSL_TERM_RE =
  /color\.rgb \*= mix\(1\.0, effectiveNightDarkness, ([^);]+)\);/;

/**
 * The share half of the term, as each shader spells it. The floor is the packed
 * scalar; the share is the largest night-side opacity any layer resolved on
 * this fragment; and the fallback supplies the complement.
 */
const WGSL_SHARE_RE =
  /let effectiveNightDarkness = (mix\(tile\.hsbShift\.w, 1\.0, clamp\(nightImageryCoverage, 0\.0, 1\.0\)\));/;
const GLSL_SHARE_RE =
  /float effectiveNightDarkness = (mix\(u_nightDarkness, 1\.0, clamp\(g_nightImageryCoverage, 0\.0, 1\.0\)\));/;

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

/**
 * The multiplier a source's own term applies, as a function of N·L.
 *
 * Both halves are read out of the source: the share expression is pinned by
 * regex and its arithmetic transcribed here, and the blend argument is captured
 * so the wrong-side mutant writes a spelling this cannot resolve.
 *
 * @param {string} source The shader text.
 * @param {RegExp} regex The backend's darkening term.
 * @param {RegExp} shareRegex The backend's share expression.
 * @param {number} darkness The packed floor.
 * @param {number} [coverage] The share the layers resolved on this fragment.
 * @returns {Function} The multiplier, as a function of N·L.
 */
function multiplierFrom(source, regex, shareRegex, darkness, coverage = 0) {
  const code = stripLineComments(source);
  const match = regex.exec(code);
  assert.ok(match, "the darkening term was not found in its source");
  assert.match(code, shareRegex, "the share expression was not found");
  const argument = blendArgument(match[1]);
  assert.ok(argument, `unrecognised blend argument: ${match[1]}`);
  const effective = effectiveDarkness(darkness, coverage);
  // Composed the same way the share is, so both endpoints of the OUTER mix are
  // exact for the same structural reason: at full night the multiplier is the
  // share itself and at full day it is 1, with no round trip through a subtract.
  return (ndotl) => {
    const blend = argument(nightBlend(ndotl));
    return 1.0 * (1 - blend) + effective * blend;
  };
}

/**
 * The share arithmetic both shaders spell, transcribed; the two share regexes
 * pin the transcription against each source, and C2d EXECUTES the shipped text
 * itself so the transcription cannot drift silently. `coverage` is the largest
 * night-side opacity any day/night layer resolved on the fragment.
 *
 * @param {number} darkness The floor the packers send.
 * @param {number} coverage The share the layers cover.
 * @returns {number} The multiplier the term mixes toward.
 */
function effectiveDarkness(darkness, coverage) {
  const t = Math.min(Math.max(coverage, 0), 1);
  return darkness * (1 - t) + 1.0 * t;
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
  const m = multiplierFrom(wgsl, WGSL_TERM_RE, WGSL_SHARE_RE, 0.15);
  assertClose(m(-1), 0.15, "deep night takes the floor");
  assertClose(m(0), 0.15, "at the geometric terminator it is still full night");
  assertClose(m(0.2), 1, "the ramp saturates to full day at N·L = 0.2");
  assertClose(m(1), 1, "subsolar is untouched");
});

test("A2: the GLSL term is the same function of N·L", () => {
  const w = multiplierFrom(wgsl, WGSL_TERM_RE, WGSL_SHARE_RE, 0.15);
  const g = multiplierFrom(glsl, GLSL_TERM_RE, GLSL_SHARE_RE, 0.15);
  let worst = 0;
  for (const ndotl of GRID) {
    worst = Math.max(worst, Math.abs(w(ndotl) - g(ndotl)));
  }
  assert.equal(worst, 0, "the two backends must darken by the same factor");
});

test("A3: it is monotone across dusk — no band, no reversal", () => {
  const m = multiplierFrom(wgsl, WGSL_TERM_RE, WGSL_SHARE_RE, 0.15);
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

test("A4: the identity floor is still exactly inert, wherever it comes from", () => {
  // The byte-identity guarantee, expressed as arithmetic: at a floor of 1.0 no
  // N·L produces a factor other than 1, so a globe that resolves to the
  // identity cannot change colour even though the term is compiled.
  const m = multiplierFrom(wgsl, WGSL_TERM_RE, WGSL_SHARE_RE, 1.0);
  for (const ndotl of GRID) {
    // Exact, not approximate: `a + (b - a) * t` with a === b is `a + 0 * t`,
    // which is `a` for every finite t in IEEE 754. That is what makes the
    // opt-out path byte-identical rather than merely close.
    assert.equal(m(ndotl), 1, `identity must hold at N·L = ${ndotl}`);
  }
  assert.equal(
    NIGHT_DARKNESS_IDENTITY,
    1,
    "the name the code uses for that floor must BE that floor",
  );
  // The per-frame mirror still starts at the identity: it is read on frames
  // before Globe.update has resolved anything into it, and a provider that
  // never heard of the property must not darken.
  assert.match(
    tileProvider,
    /this\.nightDarkness = 1\.0;/,
    "the backend-neutral per-frame mirror starts inert",
  );
});

test("A4b: the SHIPPED default darkens, and only the opt-out gives it back", () => {
  // The claim is about behaviour, not about a literal: run the shipped
  // resolution over the whole reachable state space and read the floors off it.
  //
  // A globe that never touched either property is the fork's default path and
  // must darken; every value nightImagery can hold except false is still that
  // path, INCLUDING the application-managed stack the globe never injects a
  // layer into, because building your own imagery is not a statement about the
  // night side.
  const provider = { url: "https://example.invalid/night" };
  const stillTheForkDefault = [true, provider, Promise.resolve(provider)];
  for (const request of stillTheForkDefault) {
    assert.equal(
      resolveNightDarkness(NIGHT_DARKNESS_DEFAULT, false, request),
      NIGHT_DARKNESS_DEFAULT,
      "an unassigned floor must darken while the fork's night path is in play",
    );
  }
  assert.ok(
    NIGHT_DARKNESS_DEFAULT < 1,
    "a shipped default that did not darken would make the whole row inert",
  );
  // ...and the values that ARE a statement about the night side. The two halves
  // of the night appearance switch off together: whatever makes the layer
  // resolve to "attach nothing" on the globe's own account must also give the
  // identity floor back, or an application that switched night imagery off
  // would still be looking at a procedurally darkened globe.
  for (const declined of [false, undefined, null]) {
    assert.equal(
      resolveNightDarkness(NIGHT_DARKNESS_DEFAULT, false, declined),
      NIGHT_DARKNESS_IDENTITY,
      `declining with ${String(declined)} must restore upstream exactly`,
    );
    assert.deepEqual(
      resolveNightImageryRequest(declined, true),
      { source: NightImagerySource.NONE, provider: undefined },
      "and must be a value the layer half also declines",
    );
  }
  // Executed against each other, not asserted twice: the two halves must agree
  // on every value the property accepts, including the ones that attach.
  for (const request of [...stillTheForkDefault, false, undefined, null]) {
    const layerAttaches =
      resolveNightImageryRequest(request, true).source !==
      NightImagerySource.NONE;
    const floorDarkens =
      resolveNightDarkness(NIGHT_DARKNESS_DEFAULT, false, request) !==
      NIGHT_DARKNESS_IDENTITY;
    assert.equal(
      layerAttaches,
      floorDarkens,
      `the two halves disagree for ${String(request)}`,
    );
  }
  // An assigned value is a request and survives the opt-out, which is what
  // keeps procedural-only darkening reachable.
  for (const floor of [0, 0.15, 0.5, 1]) {
    assert.equal(
      resolveNightDarkness(floor, true, false),
      floor,
      "an assigned floor must apply even with night imagery off",
    );
    assert.equal(resolveNightDarkness(floor, true, true), floor);
  }
});

test("A5: a WRONG-SIDE term is a different function, so the law can detect it", () => {
  // The discriminator for mutants E4 and E6. If the two laws agreed anywhere
  // that mattered, those mutants would survive.
  const right = multiplierFrom(wgsl, WGSL_TERM_RE, WGSL_SHARE_RE, 0.15);
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
  const term = wgslCode.indexOf(
    "color = color * mix(1.0, effectiveNightDarkness,",
  );
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
  const term = glslCode.indexOf(
    "color.rgb *= mix(1.0, effectiveNightDarkness,",
  );
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
 * WebGL arms its compile-time define off the floor alone. It has to: the share
 * is not known until the fragment resolves it, so arming on a folded product
 * would compile the term out of tiles whose fragments still need it.
 *
 * @param {number} darkness The floor.
 * @returns {boolean} Whether the define is raised.
 */
function webglArmed(darkness) {
  return darkness < 1.0;
}

/**
 * WebGPU's guard, likewise. The float round trip is deliberate: the scalar
 * reaches the shader packed into a Float32Array slot and is read back with the
 * same threshold, so this is the comparison the GPU actually performs.
 *
 * @param {number} darkness The floor.
 * @returns {boolean} Whether the guard opens.
 */
function webgpuArmed(darkness) {
  return Math.fround(darkness) < 1.0;
}

test("C1: WebGL sends the floor and its shader resolves the share", () => {
  assert.match(
    tileRendering,
    /uniformMapProperties\.nightDarkness = nightDarkness;\s*surfaceShaderSetOptions\.applyNightDarkness = nightDarkness < 1\.0;/,
    "the uniform the shader multiplies by and the define that gates it must " +
      "come from the one number, or a tile can be armed on a value it will " +
      "not receive",
  );
  assert.match(
    shaderSet,
    /if \(applyNightDarkness\) \{\s*fs\.defines\.push\("APPLY_NIGHT_DARKNESS"\);\s*\}/,
  );
  // The share the packer no longer folds is resolved where the layers are.
  assert.match(glslCode, GLSL_SHARE_RE, "the fallback supplies the complement");
  assert.match(
    glslCode,
    /g_nightImageryCoverage = max\(g_nightImageryCoverage, effectiveNightAlpha \* layerAlpha\);/,
    "and the share must actually be accumulated as the layers composite",
  );
});

test("C2: WebGPU sends the same floor and its shader resolves the same share", () => {
  assert.match(
    wgslCode,
    /if \(tile\.hsbShift\.w < 1\.0\) \{\n\s*let effectiveNightDarkness = [^\n]+\n\s*color = color \* mix\(1\.0, effectiveNightDarkness, nightBlend\);\n\s*\}/,
    "the guard is the same `< 1.0` test on the floor that WebGL's define is " +
      "derived from",
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
    /data\[HSB_SHIFT_OFFSET \+ 3\] = sanitizedNightDarkness;/,
  );
  assert.match(wgslCode, WGSL_SHARE_RE);
  assert.equal(
    (
      wgslCode.match(
        /nightImageryCoverage = max\(nightImageryCoverage, r\.nightCoverage\);/g,
      ) ?? []
    ).length,
    16,
    "one accumulation per imagery slot; a short count leaves layers uncounted",
  );
});

test("C2b: the two shader laws are the same function of floor and share", () => {
  // Executed, not compared as text: the two backends must hand over at the same
  // rate, or the same scene is darker on one of them.
  for (const darkness of [0, 0.15, 0.5, 0.999]) {
    for (const coverage of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1, 1.5, -0.5]) {
      const w = multiplierFrom(
        wgsl,
        WGSL_TERM_RE,
        WGSL_SHARE_RE,
        darkness,
        coverage,
      );
      const g = multiplierFrom(
        glsl,
        GLSL_TERM_RE,
        GLSL_SHARE_RE,
        darkness,
        coverage,
      );
      for (const ndotl of GRID) {
        assert.equal(
          w(ndotl),
          g(ndotl),
          `floor ${darkness}, share ${coverage}, N·L ${ndotl}`,
        );
      }
    }
  }
});

test("C2c: full coverage is EXACTLY inert, and none of it is the full floor", () => {
  // The no-double-darkening endpoint, and the reason a fragment a night layer
  // covers keeps its city lights. Exact, because `mix(1, 1, t)` is 1 for every
  // finite t in IEEE 754.
  for (const source of [
    [wgsl, WGSL_TERM_RE, WGSL_SHARE_RE],
    [glsl, GLSL_TERM_RE, GLSL_SHARE_RE],
  ]) {
    const covered = multiplierFrom(source[0], source[1], source[2], 0.15, 1);
    const bare = multiplierFrom(source[0], source[1], source[2], 0.15, 0);
    for (const ndotl of GRID) {
      assert.equal(covered(ndotl), 1, "a covered fragment is not darkened");
    }
    assert.equal(
      bare(-1),
      0.15,
      "an uncovered fragment takes the whole floor, exactly",
    );
    // ...and in between the two hand over without a step.
    let previous = -Infinity;
    for (let i = 0; i <= 20; i += 1) {
      const partial = multiplierFrom(
        source[0],
        source[1],
        source[2],
        0.15,
        i / 20,
      );
      const value = partial(-1);
      assert.ok(value >= previous - 1e-12, "more layer, less fallback");
      previous = value;
    }
  }
});

/**
 * Compile one shader's share expression, straight out of the shipped source.
 *
 * The right-hand side is captured by the share regex, wrapped in a function the
 * evaluator can read, and run against globals shaped like the shader's own
 * operands. Nothing is retyped: a drift in the expression changes the numbers
 * this returns.
 *
 * `mix` is a language builtin rather than something either shader defines, so
 * its semantics are supplied here - and supplied TWICE, because the two
 * lowerings a compiler may choose are not the same arithmetic, and an endpoint
 * that is only exact under one of them is not exact.
 *
 * @param {string} source The shader text.
 * @param {RegExp} shareRegex The backend's share expression, capturing its RHS.
 * @param {Function} mix The lowering to evaluate under.
 * @param {object} operands Globals shaped like the shader's own identifiers.
 * @returns {number} The share the shipped expression resolves to.
 */
function shareFrom(source, shareRegex, mix, operands) {
  const match = shareRegex.exec(stripLineComments(source));
  assert.ok(match, "the share expression was not found");
  const globals = { ...operands, __functions: { mix } };
  return compileFunction(
    `fn share() -> f32 { return ${match[1]}; }`,
    "share",
    globals,
  )();
}

/** The two lowerings of a linear interpolation a compiler may choose. */
const MIX_LOWERINGS = [
  ["a(1-t)+bt", (a, b, t) => a * (1 - t) + b * t],
  ["a+t(b-a)", (a, b, t) => a + t * (b - a)],
];

/**
 * The shipped expression, per backend, as a function of floor and coverage.
 *
 * @param {Function} mix The lowering to evaluate under.
 * @returns {Array} Pairs of backend name and callable.
 */
function shareLaws(mix) {
  return [
    [
      "WGSL",
      (floor, coverage) =>
        shareFrom(wgsl, WGSL_SHARE_RE, mix, {
          tile: { hsbShift: { w: floor } },
          nightImageryCoverage: coverage,
        }),
    ],
    [
      "GLSL",
      (floor, coverage) =>
        shareFrom(glsl, GLSL_SHARE_RE, mix, {
          u_nightDarkness: floor,
          g_nightImageryCoverage: coverage,
        }),
    ],
  ];
}

test("C2d: EXECUTED — the shipped share is EXACT at both ends, both dialects", () => {
  // Not "close to the floor": at zero coverage this multiplies a colour that has
  // to come out as the floor's own bits, on every street-altitude frame and on
  // every globe running with the night imagery switched off. A composition that
  // reaches the floor through a subtract and a multiply misses it by two units
  // in the last place at the shipped default, which is a different image.
  const floors = [0, 0.05, 0.15, 0.25, 0.3333333, 0.5, 0.75, 0.9, 0.99, 1];
  for (const [lowering, mix] of MIX_LOWERINGS) {
    for (const [name, share] of shareLaws(mix)) {
      for (const floor of floors) {
        assert.equal(
          share(floor, 0),
          floor,
          `${name} under ${lowering}: zero coverage must return the floor itself`,
        );
        for (const coverage of [1, 1.5, 2]) {
          assert.equal(
            share(floor, coverage),
            1.0,
            `${name} under ${lowering}: full coverage must be exactly inert`,
          );
        }
        assert.equal(
          share(floor, -0.5),
          floor,
          `${name} under ${lowering}: coverage clamps below zero`,
        );
      }
    }
  }
});

test("C2e: the endpoint is a property of the SHAPE, not of the arithmetic", () => {
  // The precondition that makes C2d non-vacuous, and the reason the shape was
  // changed: the composition this row shipped with is exact at the covered end
  // and NOT at the uncovered one, in f32, at the value the fork ships.
  const f = Math.fround;
  const previousShape = (floor, coverage) => {
    const t = f(Math.min(Math.max(coverage, 0), 1));
    return f(1 + f(f(f(floor) - 1) * f(1 - t)));
  };
  const shippedShape = (floor, coverage, mix) => {
    const t = f(Math.min(Math.max(coverage, 0), 1));
    return f(mix(f(floor), 1, t));
  };
  assert.notEqual(
    previousShape(NIGHT_DARKNESS_DEFAULT, 0),
    f(NIGHT_DARKNESS_DEFAULT),
    "precondition: the previous shape misses the shipped floor in f32",
  );
  for (const [lowering, mix] of MIX_LOWERINGS) {
    for (const floor of [0, 0.05, 0.15, 0.25, 0.5, 0.9, 0.99, 1]) {
      assert.equal(
        shippedShape(floor, 0, mix),
        f(floor),
        `${lowering}: f32 zero coverage`,
      );
      assert.equal(
        shippedShape(floor, 1, mix),
        1,
        `${lowering}: f32 full coverage`,
      );
    }
  }
});

test("C3: the two derivations agree over the whole input space", () => {
  // Arming is a question about the FLOOR alone now. The share is not known
  // until a fragment resolves it, so arming on a folded product would compile
  // the term out of tiles whose fragments still need it — and the suppression
  // that product used to express survives as the shader term's own endpoint,
  // which C2c executes.
  for (const darkness of [0, 0.15, 0.5, 0.999, 1, 1.0]) {
    assert.equal(
      webglArmed(darkness),
      webgpuArmed(darkness),
      `backends disagree at darkness=${darkness}`,
    );
  }
  assert.equal(webglArmed(0.15), true, "a floor below one arms the term");
  assert.equal(webglArmed(1.0), false, "the identity arms nothing");
  // And the share the shaders resolve is a genuine interpolation rather than a
  // rounded endpoint, which is what removes the step at the fade boundary.
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
    /#ifdef APPLY_NIGHT_DARKNESS\n\s*float effectiveNightDarkness = [^\n]+\n\s*color\.rgb \*= mix\(1\.0, effectiveNightDarkness, nightBlend\);\n#endif/,
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
  // The sanitizer moved into the shared leaf when the default became
  // conditional, because the default and the sanitizing became one decision and
  // splitting them across two files is how they drift. The pin follows it: what
  // matters is that ONE resolution stands between the public property and the
  // mirror both backends read.
  assert.match(
    globe,
    /tileProvider\.nightDarkness = resolveNightDarkness\(\s*this\._nightDarkness,\s*this\._nightDarknessExplicit,\s*this\._nightImagery,\s*\);/,
  );
  // Executed, not read: D2 pins the clamp the WebGPU packer applies to the SAME
  // mirror, so the two must agree on every value the property accepts.
  const webgpuClamp = (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(Math.max(value, 0.0), 1.0)
      : 1.0;
  const reachable = [
    -1,
    -0.0001,
    0,
    0.15,
    0.5,
    1,
    1.0001,
    2,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    null,
    "0.5",
    {},
  ];
  for (const value of reachable) {
    assert.equal(
      resolveNightDarkness(value, true, true),
      webgpuClamp(value),
      `the two sanitizers disagree at ${String(value)}`,
    );
  }
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
    /if \(tile\.hsbShift\.w < 1\.0\) \{\n\s*let effectiveNightDarkness = [^\n]+\n\s*color = color \* mix\(1\.0, effectiveNightDarkness, nightBlend\);\n\s*\}/.test(
      code,
    ) &&
    WGSL_SHARE_RE.test(code) &&
    lawDarkensNight(source, WGSL_TERM_RE)
  );
}
function glslTermIsLive(source) {
  const code = stripLineComments(source);
  return (
    /#ifdef APPLY_NIGHT_DARKNESS\n\s*float effectiveNightDarkness = [^\n]+\n\s*color\.rgb \*= mix\(1\.0, effectiveNightDarkness, nightBlend\);\n#endif/.test(
      code,
    ) &&
    GLSL_SHARE_RE.test(code) &&
    lawDarkensNight(source, GLSL_TERM_RE)
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
  return /surfaceShaderSetOptions\.applyNightDarkness = nightDarkness < 1\.0;/.test(
    renderingSource,
  );
}
function packIsLive(tileUbSource) {
  return (
    /const sanitizedNightDarkness =\s*typeof nightDarkness === "number"/.test(
      tileUbSource,
    ) &&
    /data\[HSB_SHIFT_OFFSET \+ 3\] = sanitizedNightDarkness;/.test(
      tileUbSource,
    ) &&
    !/data\[HSB_SHIFT_OFFSET \+ 3\] = 1\.0;/.test(tileUbSource)
  );
}
/**
 * The suppression half of the law, on each backend: a share that can never be
 * anything but zero leaves the fallback darkening a night side a layer is
 * already painting, which is the double darkening this row exists to avoid.
 * Absence mutants do not find it — every symbol is still present.
 *
 * Read out of the SHADERS, because that is where the share is resolved: the
 * term that consumes it, and the accumulation that fills it as each layer
 * composites.
 *
 * @param {string} wgslSource The WGSL globe shader.
 * @param {string} glslSource The GLSL globe shader.
 * @returns {boolean} Whether both halves are live on both backends.
 */
function coverageIsLive(wgslSource, glslSource) {
  const wgslText = stripLineComments(wgslSource);
  const glslText = stripLineComments(glslSource);
  return (
    WGSL_SHARE_RE.test(wgslText) &&
    (
      wgslText.match(
        /nightImageryCoverage = max\(nightImageryCoverage, r\.nightCoverage\);/g,
      ) ?? []
    ).length === 16 &&
    /let nightCoverage = select\(0\.0, effectiveNightAlpha \* layer\.alpha,/.test(
      wgslText,
    ) &&
    GLSL_SHARE_RE.test(glslText) &&
    /g_nightImageryCoverage = max\(g_nightImageryCoverage, effectiveNightAlpha \* layerAlpha\);/.test(
      glslText,
    )
  );
}

test("E1: ABSENCE — deleting the WGSL multiply is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "    color = color * mix(1.0, effectiveNightDarkness, nightBlend);\n",
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
    "    color = color * mix(1.0, effectiveNightDarkness, nightBlend);",
    "    let unusedNightDarken = color * mix(1.0, effectiveNightDarkness, nightBlend);",
  );
  assert.equal(wgslTermIsLive(mutant), false);
});

test("E4: WRONG SIDE — a WGSL term on the day side is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "color = color * mix(1.0, effectiveNightDarkness, nightBlend);",
    "color = color * mix(1.0, effectiveNightDarkness, 1.0 - nightBlend);",
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
    "    color.rgb *= mix(1.0, effectiveNightDarkness, nightBlend);\n",
    "",
  );
  assert.equal(glslTermIsLive(mutant), false);
});

test("E6: WRONG SIDE — a GLSL term on the day side is REJECTED", () => {
  const mutant = mutate(
    glsl,
    "color.rgb *= mix(1.0, effectiveNightDarkness, nightBlend);",
    "color.rgb *= mix(1.0, effectiveNightDarkness, 1.0 - nightBlend);",
  );
  assert.equal(glslTermIsLive(mutant), false);
});

test("E7: INERTNESS — a define that is derived but never true is REJECTED", () => {
  const mutant = mutate(
    tileRendering,
    "    surfaceShaderSetOptions.applyNightDarkness = nightDarkness < 1.0;",
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
    "  data[HSB_SHIFT_OFFSET + 3] = sanitizedNightDarkness;",
    "  data[HSB_SHIFT_OFFSET + 3] = 1.0;",
  );
  assert.equal(packIsLive(mutant), false);
});

test("E8a: INERTNESS — a GLSL share pinned at zero is REJECTED", () => {
  // The suppression half, which absence mutants cannot reach: the share is
  // still computed, the define still derived, and every fragment a night layer
  // covers is darkened a second time on top of the layer's own city lights.
  const mutant = mutate(
    glsl,
    "clamp(g_nightImageryCoverage, 0.0, 1.0)",
    "clamp(0.0, 0.0, 1.0)",
  );
  assert.equal(coverageIsLive(wgsl, mutant), false);
});

test("E8b: INERTNESS — a WGSL share pinned at zero is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "clamp(nightImageryCoverage, 0.0, 1.0)",
    "clamp(0.0, 0.0, 1.0)",
  );
  assert.equal(coverageIsLive(mutant, glsl), false);
});

test("E8c: INERTNESS — a share accumulator that never rises is REJECTED", () => {
  // The other end of the same failure: the share is read, but nothing ever
  // writes it, so a covering layer never suppresses anything.
  const glslMutant = mutate(
    glsl,
    "g_nightImageryCoverage = max(g_nightImageryCoverage, effectiveNightAlpha * layerAlpha);",
    "g_nightImageryCoverage = min(g_nightImageryCoverage, effectiveNightAlpha * layerAlpha);",
  );
  assert.equal(coverageIsLive(wgsl, glslMutant), false);
  // One slot short is the WGSL shape of the same failure: fifteen accumulations
  // silently drop whichever layer landed in the sixteenth slot.
  const accumulation =
    "    nightImageryCoverage = max(nightImageryCoverage, r.nightCoverage);\n";
  const lastSlot = wgsl.lastIndexOf(accumulation);
  assert.ok(lastSlot > 0, "the last accumulation was not found");
  const wgslMutant =
    wgsl.slice(0, lastSlot) + wgsl.slice(lastSlot + accumulation.length);
  assert.notEqual(wgslMutant, wgsl, "the last-slot mutation did not apply");
  assert.equal(coverageIsLive(wgslMutant, glsl), false);
});

test("E9: the mutants are DISCRIMINATING — the real sources pass every predicate", () => {
  assert.equal(wgslTermIsLive(wgsl), true);
  assert.equal(glslTermIsLive(glsl), true);
  assert.equal(defineIsReachable(tileRendering), true);
  assert.equal(packIsLive(tileUb), true);
  assert.equal(coverageIsLive(wgsl, glsl), true);
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

// ─── F. MUTANTS for the DEFAULT — the leaf's own source, executed ───────────
//
// Section E mutates shader and packer TEXT in memory, because what it checks is
// a law read out of that text. The default is a different kind of claim: it is
// a decision taken by a function, so it has to be IMPORTED and RUN rather than
// pattern-matched, and a mutant has to change what the import returns.
//
// The mutant therefore runs against a private copy of the leaf, written outside
// the repository with its two relative imports rewritten to absolute URLs. Not
// for tidiness: the tracked file is read at module load by several specs in
// this fleet and mutated by another, so a mutant that wrote it would race any
// concurrent run and hand some other spec a source neither of them chose. The
// copy is byte-identical to the shipped leaf, verified below, so what executes
// is still the shipped decision — and this spec writes nothing inside the tree
// at all, which F8 checks.

const LEAF_PATH = "packages/engine/Source/Scene/GlobeNightImagery.js";
const leafAbsolute = path.join(root, LEAF_PATH);
const leafOriginal = fs.readFileSync(leafAbsolute);
const leafOriginalHash = sha256(leafOriginal);
const leafSourceDirectory = path.dirname(leafAbsolute);
const leafScratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "globe-night-darkness-"),
);

process.on("exit", () => {
  fs.rmSync(leafScratch, { recursive: true, force: true });
});

let leafMutantSerial = 0;

/**
 * Write one mutated copy of the leaf outside the tree and import it.
 *
 * The relative specifiers are rewritten rather than the file relocated inside
 * the package, so nothing untracked is ever created next to the source. A
 * mutation whose needle does not match throws, so a mutant that silently missed
 * cannot report the green it never earned.
 */
async function withMutatedLeaf(from, to, assertion) {
  const source = leafOriginal.toString("utf8").replaceAll(CRLF, LF);
  assert.ok(
    source.includes(from),
    `mutation precondition failed: "${from.slice(0, 60)}..."`,
  );
  leafMutantSerial += 1;
  const mutated = source
    .replace(from, to)
    .replaceAll(
      /from "(\.\.\/[^"]+)"/g,
      (whole, specifier) =>
        `from "${pathToFileURL(path.resolve(leafSourceDirectory, specifier)).href}"`,
    );
  const copy = path.join(leafScratch, `leaf-${leafMutantSerial}.mjs`);
  fs.writeFileSync(copy, mutated);
  assertion(await import(pathToFileURL(copy).href));
}

test("F0: the executed copy is the shipped leaf, minus the mutation", async () => {
  // Anti-vacuity for the whole section: an unmutated copy must import and must
  // agree with the tracked module, or every mutant below would be probing
  // something other than what ships.
  const shipped = await import(pathToFileURL(leafAbsolute).href);
  await withMutatedLeaf(
    "export const NIGHT_DARKNESS_DEFAULT = 0.15;",
    "export const NIGHT_DARKNESS_DEFAULT = 0.15;\n",
    (copy) => {
      assert.equal(copy.NIGHT_DARKNESS_DEFAULT, shipped.NIGHT_DARKNESS_DEFAULT);
      assert.equal(
        copy.NIGHT_DARKNESS_IDENTITY,
        shipped.NIGHT_DARKNESS_IDENTITY,
      );
      for (const request of [true, false, undefined, null, {}]) {
        assert.equal(
          copy.resolveNightDarkness(0.4, false, request),
          shipped.resolveNightDarkness(0.4, false, request),
        );
      }
    },
  );
});

/**
 * The whole default decision as one verdict over the reachable state space.
 *
 * Every mutant below must flip it, and the control must not.
 */
function defaultVerdict(leaf) {
  const provider = { url: "https://example.invalid/night" };
  const darkensWhenInPlay = [true, provider].every(
    (request) =>
      leaf.resolveNightDarkness(leaf.NIGHT_DARKNESS_DEFAULT, false, request) <
      1,
  );
  const restoresOnDecline = [false, undefined, null].every(
    (request) =>
      leaf.resolveNightDarkness(leaf.NIGHT_DARKNESS_DEFAULT, false, request) ===
      1,
  );
  const honoursAnAssignment = [0, 0.3, 1].every(
    (floor) => leaf.resolveNightDarkness(floor, true, false) === floor,
  );
  return darkensWhenInPlay && restoresOnDecline && honoursAnAssignment;
}

test("F1: the shipped leaf satisfies the verdict the mutants must break", async () => {
  const leaf = await import(pathToFileURL(leafAbsolute).href);
  assert.equal(defaultVerdict(leaf), true);
});

test("F2: ABSENCE — the opt-out arm removed", async () => {
  await withMutatedLeaf(
    `    return nightImageryIsDeclined(nightImagery)
      ? NIGHT_DARKNESS_IDENTITY
      : NIGHT_DARKNESS_DEFAULT;`,
    "    return NIGHT_DARKNESS_DEFAULT;",
    (leaf) => assert.equal(defaultVerdict(leaf), false),
  );
});

test("F3: INVERTED — the two arms swapped", async () => {
  // The plausible typo, and the one no absence mutant finds: every symbol is
  // still there, and the globe darkens exactly where it must not.
  await withMutatedLeaf(
    `      ? NIGHT_DARKNESS_IDENTITY
      : NIGHT_DARKNESS_DEFAULT;`,
    `      ? NIGHT_DARKNESS_DEFAULT
      : NIGHT_DARKNESS_IDENTITY;`,
    (leaf) => assert.equal(defaultVerdict(leaf), false),
  );
});

test("F4: SWALLOWED — an assigned floor stops being a request", async () => {
  await withMutatedLeaf("  if (explicit !== true) {", "  if (true) {", (leaf) =>
    assert.equal(defaultVerdict(leaf), false),
  );
});

test("F5: REVERTED — the shipped default back at the identity", async () => {
  // Inert rather than absent: the whole mechanism still runs and darkens
  // nothing, which is what this row was asked to change.
  await withMutatedLeaf(
    "export const NIGHT_DARKNESS_DEFAULT = 0.15;",
    "export const NIGHT_DARKNESS_DEFAULT = 1.0;",
    (leaf) => assert.equal(defaultVerdict(leaf), false),
  );
});

test("F6: HALF-DECLINED — only the literal false counts as declining", async () => {
  // The state that would leave an application which switched night imagery off
  // looking at a procedurally darkened globe anyway.
  await withMutatedLeaf(
    "  return nightImagery === false || !defined(nightImagery);",
    "  return nightImagery === false;",
    (leaf) => assert.equal(defaultVerdict(leaf), false),
  );
});

test("F7: the mutants are discriminating, not merely destructive", async () => {
  // A control on the same lines: a change that cannot alter the decision must
  // leave the verdict standing, or F2-F6 would only be proving the file can be
  // broken.
  await withMutatedLeaf(
    "export function nightImageryIsDeclined(nightImagery) {",
    "export function nightImageryIsDeclined(nightImagery /* the request */) {",
    (leaf) => assert.equal(defaultVerdict(leaf), true),
  );
});

test("F8: nothing inside the tree was written", () => {
  assert.equal(
    sha256(fs.readFileSync(leafAbsolute)),
    leafOriginalHash,
    "the tracked leaf must be untouched — mutants run on a copy outside it",
  );
  assert.ok(
    !leafScratch.startsWith(root),
    "the mutant copies must live outside the repository",
  );
});
