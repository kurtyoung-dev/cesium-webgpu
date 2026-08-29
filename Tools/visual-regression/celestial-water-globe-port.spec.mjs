// celestial-water-globe-port.spec.mjs — the celestial reflection on the globe's
// own water, on both backends, and the off contract that leaves the default
// globe exactly as it was.
//
// @purpose Executes the globe ocean's celestial glint law out of the shipped WGSL, holds the GLSL twin and the FFT twin equal to it by normalised source comparison, and measures the exact-zero off contract of the camera-UB tail.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/celestial-water-globe-port.spec.mjs
//
// WHAT THIS SPEC IS FOR. The feature was prototyped on the opt-in FFT ocean and
// then ported onto the water the globe draws from its water mask. The port has
// three places to go wrong that a rendered pixel would not obviously reveal:
//
//   1. It could reach only one of the two styling arms. `ENHANCED_OCEAN` is a
//      preprocessor define and `Globe.enableEnhancedOcean` defaults FALSE, so
//      the arm a default globe compiles is the CLASSIC one. A port that landed
//      on the enhanced arm alone would look complete in review and be
//      unreachable from a default scene.
//   2. The three copies of the law — the FFT WGSL, the globe WGSL, the globe
//      GLSL — could drift. They are separate shader modules in two languages
//      and cannot share a function.
//   3. Off could stop being exact. The feature is opt-in and default off, and
//      the bar it was ruled under is that the globe renders what it always
//      rendered while it is off.
//
// HOW IT AVOIDS CERTIFYING ITSELF. Nothing below transcribes a shader law into
// JavaScript and then asserts the transcription. Group C EVALUATES the shipped
// WGSL through `lib/wgsl-mini-eval.mjs`, so every number comes from the text
// that ships. Groups D and E hold the other two copies equal to it by
// normalising both sources into one token stream and comparing them — an edit
// to one that is not made to the other fails here, whichever one was edited.
// Group F executes the CPU resolver rather than restating it.
//
// WHAT IT DELIBERATELY DOES NOT PROVE. The evaluator computes in f64 where the
// GPU computes in f32, so it establishes the SHAPE of the lobe and its limits,
// not bit-level agreement with a device. Nothing here draws a pixel: the
// rendered-output half of the off contract belongs to a browser leg, and this
// spec's contribution to it is that the tail is exact zeros, the gate is closed
// and the historical Phong text is intact in both arms.
//
// THE EVALUATOR'S ONE SHIM. `wgsl-mini-eval` models member access but not
// swizzles, so where the shader reads `camera.celestialMoonDirectionAndPhase.xyz`
// the spec binds an `xyz` member alongside `x`, `y`, `z`, `w`. B4 checks that
// the shim is faithful — that `.xyz` is applied to that lane and no other — so
// the convenience cannot hide a lane mix-up.
//
// CRLF: this repo checks out with `core.autocrlf=true`; every reader below
// normalises line endings before matching.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileFunction,
  evaluate,
  parseExpression,
  readConstants,
  stripComments,
  tokenize,
  vec,
} from "./lib/wgsl-mini-eval.mjs";
import {
  CELESTIAL_DEFAULT_MOON_INTENSITY,
  CELESTIAL_DEFAULT_ROUGHNESS,
  CELESTIAL_DEFAULT_SUN_INTENSITY,
  CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
  CELESTIAL_SUN_SIN_ANGULAR_RADIUS,
  resolveCelestialWaterTail,
} from "../../packages/engine/Source/Scene/CelestialWaterReflection.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const GLOBE_WGSL_PATH = path.join(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);
const OCEAN_WGSL_PATH = path.join(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/Ocean/OceanSurface.wgsl",
);
const GLOBE_GLSL_PATH = path.join(
  ROOT,
  "packages/engine/Source/Shaders/GlobeFS.glsl",
);
const CAMERA_UB_PATH = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
);
const TYPES_PATH = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
);
const RENDERING_PATH = path.join(
  ROOT,
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
);
const SHADER_SET_PATH = path.join(
  ROOT,
  "packages/engine/Source/Scene/GlobeSurfaceShaderSet.js",
);
const GLOBE_JS_PATH = path.join(ROOT, "packages/engine/Source/Scene/Globe.js");

/**
 * Read a source file with its line endings normalised to LF.
 *
 * @param {string} file Absolute path.
 * @returns {string} The source.
 */
function read(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

const globeWgsl = read(GLOBE_WGSL_PATH);
const oceanWgsl = read(OCEAN_WGSL_PATH);
const globeGlsl = read(GLOBE_GLSL_PATH);
const cameraUbTs = read(CAMERA_UB_PATH);
const typesTs = read(TYPES_PATH);
const renderingJs = read(RENDERING_PATH);
const shaderSetJs = read(SHADER_SET_PATH);
const globeJs = read(GLOBE_JS_PATH);

const globeStripped = stripComments(globeWgsl);
const oceanStripped = stripComments(oceanWgsl);

// The globe shader declares scores of constants the evaluator has no reason to
// read, some of them in forms outside its subset, so the constant table is
// built from the celestial block plus the file's own `PI` rather than from the
// whole module. Slicing keeps `readConstants`' fail-closed behaviour pointed at
// the text this spec is about.
const CELESTIAL_BLOCK_START = globeStripped.indexOf("const CELESTIAL_WATER_F0");
const CELESTIAL_BLOCK_END = globeStripped.indexOf("fn computeEnhancedOcean");
assert.ok(
  CELESTIAL_BLOCK_START > 0 && CELESTIAL_BLOCK_END > CELESTIAL_BLOCK_START,
  "the globe shader must carry a celestial constants block before computeEnhancedOcean",
);
const piLine = /^const PI: f32 = [^;]+;/m.exec(globeStripped);
assert.ok(piLine !== null, "the globe shader must declare PI");
const GLOBE_CONSTANTS = readConstants(
  `${piLine[0]}\n${globeStripped.slice(CELESTIAL_BLOCK_START, CELESTIAL_BLOCK_END)}`,
);

// The two discs' angular radii travel as uniforms in both WGSL oceans — the
// CPU resolves them once and packs them — so neither shader declares them, and
// the GLSL twin, which has no uniform for the Moon's, hardcodes it. The CPU
// module is therefore the single source, and the table below is what every
// copy is measured against.
const EXPECTED_CONSTANTS = {
  ...GLOBE_CONSTANTS,
  CELESTIAL_SUN_SIN_ANGULAR_RADIUS,
  CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
};

const globeFunctions = {};
const globeGlobals = { ...GLOBE_CONSTANTS, __functions: globeFunctions };
for (const name of [
  "celestialNightGate",
  "celestialDistributionGGX",
  "celestialSmithG1",
  "celestialGlint",
  "computeCelestialWaterSpecular",
]) {
  globeFunctions[name] = compileFunction(globeStripped, name, globeGlobals);
}
const {
  celestialNightGate,
  celestialDistributionGGX,
  celestialSmithG1,
  celestialGlint,
  computeCelestialWaterSpecular,
} = globeFunctions;

const UP = vec(0, 0, 1);

/**
 * A unit direction at polar angle `theta` from up, azimuth `phi`.
 *
 * @param {number} theta Polar angle in radians.
 * @param {number} phi Azimuth in radians.
 * @returns {object} The direction.
 */
function dir(theta, phi) {
  return vec(
    Math.sin(theta) * Math.cos(phi),
    Math.sin(theta) * Math.sin(phi),
    Math.cos(theta),
  );
}

/**
 * Bind the camera uniform lanes the celestial block reads.
 *
 * The `xyz` member is the evaluator's swizzle shim, documented in the header
 * and checked by B4.
 *
 * @param {object} options Lane values.
 * @param {number} [options.enable] `celestialControl.x`.
 * @param {number} [options.roughness] `celestialControl.y`.
 * @param {number} [options.sunIntensity] `celestialControl.z`.
 * @param {number} [options.sunSin] `celestialControl.w`.
 * @param {object} [options.moonDirection] The Moon's eye-space direction.
 * @param {number} [options.moonPhase] The illuminated fraction.
 * @param {number} [options.moonIntensity] `celestialMoonControl.x`.
 * @param {number} [options.moonSin] `celestialMoonControl.y`.
 * @returns {object} A `camera` binding.
 */
function cameraLanes({
  enable = 1,
  roughness = 0.06,
  sunIntensity = 1,
  sunSin = 0.0046524,
  moonDirection = vec(0, 0, 0),
  moonPhase = 0,
  moonIntensity = 0.35,
  moonSin = 0.0045213,
} = {}) {
  return {
    celestialControl: {
      x: enable,
      y: roughness,
      z: sunIntensity,
      w: sunSin,
    },
    celestialMoonDirectionAndPhase: {
      x: moonDirection.x,
      y: moonDirection.y,
      z: moonDirection.z,
      w: moonPhase,
      xyz: vec(moonDirection.x, moonDirection.y, moonDirection.z),
    },
    celestialMoonControl: { x: moonIntensity, y: moonSin },
  };
}

/**
 * The shader's own moon-rise weight for a direction, read off the constant it
 * is written against.
 *
 * @param {object} moonDirection The Moon's direction, against a (0,0,1) up.
 * @returns {number} The weight in [0, 1].
 */
function riseGate(moonDirection) {
  const edge = GLOBE_CONSTANTS.CELESTIAL_MOON_RISE_SIN;
  const t = Math.min(Math.max(moonDirection.z / edge, 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Evaluate `computeCelestialWaterSpecular` with the given camera lanes.
 *
 * @param {object} lanes The result of {@link cameraLanes}.
 * @param {object[]} args The function's own arguments.
 * @returns {object} The returned colour.
 */
function specularWith(lanes, ...args) {
  globeGlobals.camera = lanes;
  try {
    return computeCelestialWaterSpecular(...args);
  } finally {
    delete globeGlobals.camera;
  }
}

/**
 * Extract one function's parameter names and body from GLSL by brace matching.
 *
 * The WGSL evaluator's extractor keys on `fn NAME(`, which GLSL does not write.
 *
 * @param {string} src GLSL source.
 * @param {string} name The function name.
 * @returns {{params: string[], body: string}} Parameters and body text.
 */
function extractGlslFunction(src, name) {
  const re = new RegExp(`\\b[A-Za-z0-9_]+\\s+${name}\\s*\\(`);
  const at = src.search(re);
  assert.ok(at >= 0, `GLSL function ${name} not found`);
  const open = src.indexOf("(", at);
  let depth = 0;
  let i = open;
  for (; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const params = src
    .slice(open + 1, i)
    .split(",")
    .map((p) => p.trim().split(/\s+/).pop())
    .filter((p) => p.length > 0);
  const brace = src.indexOf("{", i);
  depth = 0;
  let j = brace;
  for (; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return { params, body: src.slice(brace + 1, j) };
}

/**
 * Reduce a shader function body to a language-neutral token stream.
 *
 * The three copies of this law are written in two languages, so a byte
 * comparison cannot hold them equal. What CAN be held equal is the arithmetic
 * once the declaration syntax is removed: WGSL's `let x = ...` and GLSL's
 * `float x = ...` are the same statement, and the `PI` each dialect names
 * differently is the same number to f32. Everything else — every operand,
 * every constant name, every call, every ordering — must match exactly, so a
 * changed coefficient or a dropped term fails.
 *
 * @param {string} text The function body.
 * @param {"wgsl"|"glsl"} dialect Which syntax to strip.
 * @returns {string} The canonical form.
 */
function canonicalise(text, dialect) {
  let t = text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (dialect === "wgsl") {
    t = t
      // Declaration keywords and type annotations.
      .replace(/\b(?:let|var)\s+/g, "")
      .replace(/\s*:\s*(?:f32|vec2<f32>|vec3<f32>|vec4<f32>)\b/g, "")
      .replace(/vec3<f32>/g, "vec3")
      // The FFT copy prefixes the constant; the globe copy reuses the file's.
      .replace(/\bCELESTIAL_PI\b/g, "PI");
  } else {
    t = t
      // Declaration types, but never a constructor: a type is followed by an
      // identifier, a constructor by an open parenthesis.
      .replace(/\b(?:float|vec2|vec3|vec4)\s+(?=[A-Za-z_][A-Za-z0-9_]*)/g, "")
      .replace(/\bczm_pi\b/g, "PI");
  }
  return t
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;{}[\]*/+\-<>=!&|.])\s*/g, "$1")
    .trim();
}

// ───────── A. the port reached the ocean a default globe actually draws ──────

test("A1 both styling arms call the celestial law, not just the enhanced one", () => {
  const calls = (globeStripped.match(/computeCelestialWaterSpecular\(/g) ?? [])
    .length;
  // One declaration plus one call site in each arm.
  assert.equal(
    calls,
    3,
    "expected the definition and one call in each of the two ocean arms",
  );

  // The arms are delimited by preprocessor directives, which are line comments;
  // the stripped source cannot see them, so this reads the raw text.
  const fn = globeWgsl.slice(globeWgsl.indexOf("fn computeEnhancedOcean"));
  const enhancedStart = fn.indexOf("//>>ifdef ENHANCED_OCEAN");
  const elseAt = fn.indexOf("//>>else");
  const endAt = fn.indexOf("//>>endif");
  assert.ok(
    enhancedStart > 0 && elseAt > enhancedStart && endAt > elseAt,
    "computeEnhancedOcean must still be split into an enhanced and a classic arm",
  );

  const enhancedArm = fn.slice(enhancedStart, elseAt);
  const classicArm = fn.slice(elseAt, endAt);
  assert.ok(
    enhancedArm.includes("computeCelestialWaterSpecular("),
    "the enhanced arm must call the celestial law",
  );
  assert.ok(
    classicArm.includes("computeCelestialWaterSpecular("),
    "the CLASSIC arm must call it too — that is the arm a default globe compiles",
  );
});

test("A2 the classic arm is the one a default globe compiles", () => {
  // The premise A1 rests on, re-derived from the property rather than assumed:
  // the enhanced arm is behind a define whose owning property defaults false.
  assert.match(
    globeJs,
    /this\.enableEnhancedOcean = false;/,
    "Globe.enableEnhancedOcean must still default false",
  );
});

test("A3 the celestial contribution reaches each arm's returned colour", () => {
  const fn = globeWgsl.slice(globeWgsl.indexOf("fn computeEnhancedOcean"));
  const elseAt = fn.indexOf("//>>else");
  const endAt = fn.indexOf("//>>endif");

  // Enhanced: added into `oceanContribution`, which the arm returns through
  // `baseColor + oceanContribution`.
  const enhancedArm = fn.slice(0, elseAt);
  assert.match(
    enhancedArm,
    /oceanContribution \+= computeCelestialWaterSpecular\(/,
    "the enhanced arm must accumulate the term, not compute and drop it",
  );
  assert.match(
    enhancedArm,
    /var color = baseColor \+ oceanContribution;/,
    "the enhanced arm must still return baseColor plus its accumulator",
  );

  // Classic: the historical three-term sum is built first and returned
  // untouched, and the celestial term is added into it only inside the gate.
  // That ordering is what keeps the off path the arithmetic it always was.
  const classicArm = fn.slice(elseAt, endAt);
  assert.match(
    classicArm,
    /classicColor \+= computeCelestialWaterSpecular\(/,
    "the classic arm must accumulate the term inside its gate",
  );
  assert.match(
    classicArm,
    /var classicColor = baseColor \+\s*classicDiffuseHighlight \+\s*classicNonDiffuseHighlight \+\s*vec3<f32>\(classicSpecular\);/,
    "the historical sum must be built unchanged, before the gate",
  );
  assert.match(classicArm, /return classicColor;/, "and returned as one value");
});

test("A4 both arms keep the historical Phong lobe as the off path", () => {
  // The pin this replaces lived in celestial-water-sun-glint.spec.mjs group F
  // and asserted the Phong lobe was the ONLY law on the globe. It is now one of
  // two, chosen at runtime, and what has to stay true is that the Phong text
  // survives intact so the off path is the arithmetic it always was.
  assert.equal(
    (globeStripped.match(/reflect\(-sunDirEC, waterNormal\)/g) ?? []).length,
    2,
    "the enhanced and classic branches must each still hold their Phong glint",
  );
  assert.equal(
    (globeStripped.match(/, 0\.0\), 10\.0\)/g) ?? []).length,
    2,
    "both must still use the shininess-10 exponent",
  );
});

test("A5 the enable is a runtime uniform, read once per arm and nowhere else", () => {
  const reads = (globeStripped.match(/camera\.celestialControl\.x/g) ?? [])
    .length;
  assert.equal(reads, 2, "one gate per ocean arm, and no other reader");
  assert.equal(
    (globeStripped.match(/if \(camera\.celestialControl\.x > 0\.0\) \{/g) ?? [])
      .length,
    2,
    "both reads must be the gate itself",
  );
  // No new define bit: the row was ruled to spend none.
  assert.ok(
    !globeWgsl.includes("CELESTIAL_WATER") ||
      !/\/\/>>ifdef\s+[A-Z_]*CELESTIAL/.test(globeWgsl),
    "the WebGPU gate must be a uniform, never a preprocessor define",
  );
});

// ───────── B. the uniform lanes ─────────────────────────────────────────────

test("B1 the WGSL struct declares the tail the packer writes", () => {
  const struct = globeStripped.slice(
    globeStripped.indexOf("struct CameraUniforms {"),
    globeStripped.indexOf("@group(0) @binding(0)"),
  );
  const tail = struct.slice(struct.indexOf("celestialControl"));
  const fields = [...tail.matchAll(/^\s*([A-Za-z0-9_]+)\s*:\s*([^,]+),/gm)].map(
    (m) => [m[1], m[2].trim()],
  );
  assert.deepEqual(fields, [
    ["celestialControl", "vec4<f32>"],
    ["celestialMoonDirectionAndPhase", "vec4<f32>"],
    ["celestialMoonControl", "vec4<f32>"],
  ]);
});

test("B2 the declared float count matches the packer's cursor", () => {
  const declared = /export const CAMERA_UNIFORM_FLOATS = (\d+);/.exec(typesTs);
  assert.ok(declared !== null, "the float count must be declared");
  assert.equal(
    Number(declared[1]),
    244,
    "232 pre-existing floats plus the three celestial vec4 lanes",
  );
  const width = /export const CELESTIAL_WATER_FLOATS = (\d+);/.exec(cameraUbTs);
  assert.ok(
    width !== null,
    "the tail width must be declared beside the writer",
  );
  assert.equal(Number(width[1]), 12);
  // And the packer checks its own arithmetic rather than trusting the two
  // numbers to stay in step.
  assert.match(
    cameraUbTs,
    /if \(offset !== CAMERA_UNIFORM_FLOATS\)/,
    "the packer must assert it wrote the declared width",
  );
});

test("B3 the tail is appended, so no existing offset moved", () => {
  const struct = globeStripped.slice(
    globeStripped.indexOf("struct CameraUniforms {"),
    globeStripped.indexOf("@group(0) @binding(0)"),
  );
  assert.ok(
    struct.indexOf("cloudShadowCascadeParams") <
      struct.indexOf("celestialControl"),
    "the celestial lanes must come after the last pre-existing field",
  );
  const lastBefore = struct.lastIndexOf("cloudShadowCascadeParams: vec4<f32>,");
  const firstNew = struct.indexOf("celestialControl: vec4<f32>,");
  assert.ok(
    !/[;}]/.test(struct.slice(lastBefore, firstNew)),
    "nothing may be inserted between them but comments",
  );
});

test("B4 the swizzle shim names the lane the shader swizzles", () => {
  // The evaluator has no swizzles, so the spec binds an `xyz` member. That is
  // only safe while the shader swizzles exactly the lane the shim covers.
  const swizzles = [
    ...globeStripped.matchAll(/camera\.(celestial[A-Za-z]*)\.(xyz|xy|zw)\b/g),
  ].map((m) => `${m[1]}.${m[2]}`);
  assert.deepEqual(
    swizzles,
    ["celestialMoonDirectionAndPhase.xyz"],
    "only the Moon direction lane may be swizzled, or the shim is hiding a lane mix-up",
  );
});

// ───────── C. the law, executed out of the shipped globe shader ─────────────

test("C1 the constants carry their documented physical values", () => {
  assert.equal(GLOBE_CONSTANTS.CELESTIAL_WATER_F0, 0.02);
  assert.equal(GLOBE_CONSTANTS.CELESTIAL_DISC_WIDEN, 0.5);
  assert.equal(GLOBE_CONSTANTS.CELESTIAL_MIN_ROUGHNESS, 0.02);
  assert.equal(GLOBE_CONSTANTS.CELESTIAL_DISTANCE_ROUGHEN, 0.25);
  for (const [name, degrees] of [
    ["CELESTIAL_MOON_SIN_ANGULAR_RADIUS", 932.58 / 3600],
    ["CELESTIAL_SUN_SIN_ANGULAR_RADIUS", 959.63 / 3600],
    ["CELESTIAL_MOON_RISE_SIN", 5],
    ["CELESTIAL_NIGHT_BAND_SIN", 3],
  ]) {
    const expected = Math.sin(degrees * (Math.PI / 180));
    assert.ok(
      Math.abs(EXPECTED_CONSTANTS[name] - expected) < 5e-7,
      `${name} = ${EXPECTED_CONSTANTS[name]} is not sin(${degrees}°)`,
    );
  }
});

test("C2 the GGX distribution integrates to one over the hemisphere", () => {
  for (const alpha of [0.05, 0.2, 0.6]) {
    const steps = 20000;
    let sum = 0;
    for (let i = 0; i < steps; i += 1) {
      const theta = ((i + 0.5) / steps) * (Math.PI / 2);
      sum +=
        celestialDistributionGGX(Math.cos(theta), alpha) *
        Math.cos(theta) *
        Math.sin(theta) *
        (Math.PI / 2 / steps);
    }
    sum *= 2 * Math.PI;
    assert.ok(
      Math.abs(sum - 1) < 0.01,
      `alpha ${alpha} integrates to ${sum}, not 1`,
    );
  }
});

test("C3 the masking term is bounded and monotone in the cosine", () => {
  for (const alpha of [0.01, 0.3, 1.0]) {
    let previous = -1;
    for (let i = 1; i <= 50; i += 1) {
      const g = celestialSmithG1(i / 50, alpha);
      assert.ok(g >= 0 && g <= 1 + 1e-12, `G1 out of range: ${g}`);
      assert.ok(g > previous, "G1 must rise with the cosine");
      previous = g;
    }
    assert.ok(Math.abs(celestialSmithG1(1, alpha) - 1) < 1e-12);
  }
});

test("C4 nothing is reflected from below the horizon", () => {
  const below = dir(Math.PI * 0.75, 0);
  const above = dir(Math.PI * 0.25, 0);
  const r = 0.06;
  const s = EXPECTED_CONSTANTS.CELESTIAL_MOON_SIN_ANGULAR_RADIUS;
  assert.equal(celestialGlint(UP, above, below, r, s), 0, "light below");
  assert.equal(celestialGlint(UP, below, above, r, s), 0, "eye below");
  assert.ok(celestialGlint(UP, above, above, r, s) > 0, "both above glints");
});

test("C5 the night gate is a terminator ramp, complementary to the day gate", () => {
  const band = GLOBE_CONSTANTS.CELESTIAL_NIGHT_BAND_SIN;
  assert.equal(celestialNightGate(UP, vec(0, 0, 1)), 0, "noon is fully day");
  assert.equal(celestialNightGate(UP, vec(0, 0, -1)), 1, "midnight is night");
  assert.ok(
    Math.abs(celestialNightGate(UP, vec(0, 0, 0)) - 0.5) < 1e-12,
    "the geometric horizon must sit at the middle of the ramp",
  );
  assert.equal(
    celestialNightGate(UP, vec(0, 0, band)),
    0,
    "the ramp must close above the band",
  );
  assert.equal(
    celestialNightGate(UP, vec(0, 0, -band)),
    1,
    "and open below it",
  );
  // Monotone across the band, so the handover cannot double back.
  let previous = -1;
  for (let i = 0; i <= 40; i += 1) {
    const altitude = band - (2 * band * i) / 40;
    const value = celestialNightGate(UP, vec(0, 0, altitude));
    assert.ok(value >= previous, "the night gate must rise as the Sun sets");
    previous = value;
  }
});

test("C6 the two lights hand over without double counting", () => {
  // The Moon sits on the mirror direction and the Sun's altitude is swept
  // across the terminator. Both terms stay live — the solar lobe has a tail
  // that reaches the mirror direction, and suppressing it to simplify the
  // arithmetic would have tested only half of the handover — so the sum below
  // is the whole law, and what it proves is that the two weights are
  // complementary rather than additive.
  const view = dir(Math.PI / 3, 0);
  const moon = dir(Math.PI / 3, Math.PI);
  const roughness = 0.06;
  const sunSin = EXPECTED_CONSTANTS.CELESTIAL_SUN_SIN_ANGULAR_RADIUS;
  const moonSin = EXPECTED_CONSTANTS.CELESTIAL_MOON_SIN_ANGULAR_RADIUS;
  const sunTint = GLOBE_CONSTANTS.CELESTIAL_SUN_TINT;
  const moonTint = GLOBE_CONSTANTS.CELESTIAL_MOON_TINT;

  for (const altitude of [0.3, 0.05, 0.0, -0.02, -0.3]) {
    const sunDir = vec(0, 0, altitude);
    const lanes = cameraLanes({
      roughness,
      sunIntensity: 1,
      sunSin,
      moonDirection: moon,
      moonPhase: 1,
      moonIntensity: 1,
      moonSin,
    });
    const night = celestialNightGate(UP, sunDir);
    const day = 1 - night;
    const sunLobe = celestialGlint(UP, view, sunDir, roughness, sunSin);
    const moonLobe = celestialGlint(UP, view, moon, roughness, moonSin);
    const rise = riseGate(moon);
    const expected =
      sunTint.x * sunLobe * day + moonTint.x * moonLobe * rise * night;
    const out = specularWith(lanes, UP, view, sunDir, UP, 1.0, 1.0);
    assert.ok(
      Math.abs(out.x - expected) <= 1e-9 * Math.max(1, expected),
      `at altitude ${altitude} the sum is ${out.x}, expected ${expected}`,
    );
    // The handover itself: the two weights are exact complements, so no
    // altitude can pay for both lights in full.
    assert.equal(day + night, 1, "the gates must be exact complements");
  }

  // And the shipped text says so, not just the arithmetic: the day gate is
  // written as one minus the night gate, never derived a second time.
  assert.match(
    globeStripped,
    /let nightGate = celestialNightGate\(upEC, sunDirEC\);\s*let dayGate = 1\.0 - nightGate;/,
    "the day gate must be the night gate's complement, in the source",
  );
});

test("C7 the moon term is gated by phase, rise angle and night together", () => {
  const view = dir(Math.PI / 3, 0);
  const moon = dir(Math.PI / 3, Math.PI);
  const midnight = vec(0, 0, -1);
  const base = {
    moonDirection: moon,
    moonPhase: 1,
    moonIntensity: 1,
    sunIntensity: 0,
  };
  const lit = specularWith(cameraLanes(base), UP, view, midnight, UP, 1.0, 1.0);
  assert.ok(lit.x > 0, "a full Moon at altitude on the night side must glint");

  // New Moon.
  assert.equal(
    specularWith(
      cameraLanes({ ...base, moonPhase: 0 }),
      UP,
      view,
      midnight,
      UP,
      1.0,
      1.0,
    ).x,
    0,
    "a new Moon reflects nothing",
  );
  // Half phase halves it, exactly.
  const half = specularWith(
    cameraLanes({ ...base, moonPhase: 0.5 }),
    UP,
    view,
    midnight,
    UP,
    1.0,
    1.0,
  );
  assert.ok(
    Math.abs(half.x - lit.x * 0.5) < 1e-12,
    "phase must scale linearly",
  );
  // Below the horizon the rise gate and the glint's own visibility test both
  // close, and the term is exactly nothing.
  const set = dir(Math.PI / 2 + 0.01, Math.PI);
  assert.equal(
    specularWith(
      cameraLanes({ ...base, moonDirection: set }),
      UP,
      view,
      midnight,
      UP,
      1.0,
      1.0,
    ).x,
    0,
    "a Moon below the horizon must not glint",
  );
  // Just above it the gate is a ramp, not a switch: the Moon is suppressed by
  // orders of magnitude rather than clipped, which is what keeps moonrise from
  // popping.
  const rising = dir(Math.PI / 2 - 1e-4, Math.PI);
  const low = specularWith(
    cameraLanes({ ...base, moonDirection: rising }),
    UP,
    view,
    midnight,
    UP,
    1.0,
    1.0,
  ).x;
  assert.ok(low > 0, "the ramp must not clip a Moon that has risen");
  assert.ok(
    low < lit.x * 1e-4,
    `a Moon on the horizon must be deeply suppressed, got ${low} against ${lit.x}`,
  );
  // Daylight closes it.
  assert.equal(
    specularWith(cameraLanes(base), UP, view, vec(0, 0, 1), UP, 1.0, 1.0).x,
    0,
    "no moonglade at noon",
  );
  // A zero direction carries itself to zero with no companion flag.
  assert.equal(
    specularWith(
      cameraLanes({ ...base, moonDirection: vec(0, 0, 0) }),
      UP,
      view,
      midnight,
      UP,
      1.0,
      1.0,
    ).x,
    0,
    "a zeroed bearing must produce nothing",
  );
});

test("C8 distance roughens the water, and the mask scales the whole term", () => {
  const view = dir(Math.PI / 3, 0);
  const moon = dir(Math.PI / 3, Math.PI);
  const midnight = vec(0, 0, -1);
  const lanes = cameraLanes({
    moonDirection: moon,
    moonPhase: 1,
    moonIntensity: 1,
    sunIntensity: 0,
    roughness: 0.06,
  });

  const near = specularWith(lanes, UP, view, midnight, UP, 1.0, 1.0);
  const far = specularWith(lanes, UP, view, midnight, UP, 0.0, 1.0);
  assert.ok(
    far.x < near.x,
    "the far band must be dimmer on axis than the near water",
  );
  // The far roughness is the near one plus the full roughening.
  const expectedFar = celestialGlint(
    UP,
    view,
    moon,
    0.06 + GLOBE_CONSTANTS.CELESTIAL_DISTANCE_ROUGHEN,
    EXPECTED_CONSTANTS.CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
  );
  assert.ok(
    Math.abs(far.x - GLOBE_CONSTANTS.CELESTIAL_MOON_TINT.x * expectedFar) <
      1e-12,
    "the far band must use exactly the roughened lobe",
  );
  // The mask is a plain scale on everything the function returns.
  const masked = specularWith(lanes, UP, view, midnight, UP, 1.0, 0.25);
  assert.ok(
    Math.abs(masked.x - near.x * 0.25) < 1e-12,
    "the water mask must scale the whole contribution",
  );
  assert.equal(
    specularWith(lanes, UP, view, midnight, UP, 1.0, 0.0).x,
    0,
    "dry land must reflect nothing",
  );
});

test("C9 the roughness floor survives the distance term", () => {
  const view = dir(Math.PI / 3, 0);
  const moon = dir(Math.PI / 3, Math.PI);
  const midnight = vec(0, 0, -1);
  const glass = specularWith(
    cameraLanes({
      moonDirection: moon,
      moonPhase: 1,
      moonIntensity: 1,
      sunIntensity: 0,
      roughness: 0.0,
    }),
    UP,
    view,
    midnight,
    UP,
    1.0,
    1.0,
  );
  const floored = celestialGlint(
    UP,
    view,
    moon,
    GLOBE_CONSTANTS.CELESTIAL_MIN_ROUGHNESS,
    EXPECTED_CONSTANTS.CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
  );
  assert.ok(
    Math.abs(glass.x - GLOBE_CONSTANTS.CELESTIAL_MOON_TINT.x * floored) < 1e-12,
    "a zero requested roughness must be lifted to the floor, not used raw",
  );
  assert.ok(Number.isFinite(glass.x) && glass.x > 0, "and must stay finite");
});

// ───────── D. the FFT twin and the globe twin are one law ───────────────────

const SHARED_WGSL_FUNCTIONS = [
  "celestialNightGate",
  "celestialDistributionGGX",
  "celestialSmithG1",
  "celestialGlint",
];

test("D1 the four shared WGSL functions are textually identical after normalisation", () => {
  for (const name of SHARED_WGSL_FUNCTIONS) {
    const a = canonicalise(compileFunctionBody(globeStripped, name), "wgsl");
    const b = canonicalise(compileFunctionBody(oceanStripped, name), "wgsl");
    assert.equal(
      a,
      b,
      `${name} has drifted between the globe ocean and the FFT ocean`,
    );
  }
});

test("D2 the shared constants carry the same values in both WGSL oceans", () => {
  const oceanBlockStart = oceanStripped.indexOf("const CELESTIAL_PI");
  const oceanBlockEnd = oceanStripped.indexOf("@vertex");
  const oceanConstants = readConstants(
    oceanStripped.slice(oceanBlockStart, oceanBlockEnd),
  );
  for (const name of [
    "CELESTIAL_WATER_F0",
    "CELESTIAL_DISC_WIDEN",
    "CELESTIAL_MIN_ROUGHNESS",
    "CELESTIAL_DISTANCE_ROUGHEN",
    "CELESTIAL_MOON_RISE_SIN",
    "CELESTIAL_NIGHT_BAND_SIN",
  ]) {
    assert.deepEqual(
      GLOBE_CONSTANTS[name],
      oceanConstants[name],
      `${name} differs between the two oceans`,
    );
  }
  // The FFT copy also carries the two angular radii as documentation — it reads
  // them from its uniforms, as the globe does — so they are held to the CPU
  // module that actually feeds both.
  for (const name of [
    "CELESTIAL_SUN_SIN_ANGULAR_RADIUS",
    "CELESTIAL_MOON_SIN_ANGULAR_RADIUS",
  ]) {
    assert.equal(
      oceanConstants[name],
      EXPECTED_CONSTANTS[name],
      `${name} has drifted from the value the CPU packs`,
    );
  }
  for (const name of ["CELESTIAL_SUN_TINT", "CELESTIAL_MOON_TINT"]) {
    assert.deepEqual(GLOBE_CONSTANTS[name], oceanConstants[name]);
  }
  // The one deliberate difference, stated so it cannot be mistaken for drift.
  assert.equal(
    oceanConstants.CELESTIAL_PI,
    GLOBE_CONSTANTS.PI,
    "the globe reuses its own PI; the values must still agree",
  );
});

// ───────── E. the WebGL twin is the same law, reduced to the Moon ───────────

test("E1 the GLSL twin runs the same four functions, term for term", () => {
  const glsl = globeGlsl;
  for (const name of SHARED_WGSL_FUNCTIONS) {
    const wgsl = canonicalise(compileFunctionBody(globeStripped, name), "wgsl");
    const twin = canonicalise(extractGlslFunction(glsl, name).body, "glsl");
    assert.equal(twin, wgsl, `the GLSL ${name} has drifted from the WGSL one`);
  }
});

test("E2 the two dialects name the same parameters in the same order", () => {
  for (const name of SHARED_WGSL_FUNCTIONS) {
    const wgslParams = extractWgslParams(globeStripped, name);
    const glslParams = extractGlslFunction(globeGlsl, name).params;
    assert.deepEqual(glslParams, wgslParams, `${name} parameter drift`);
  }
});

test("E3 the GLSL constants match the WGSL ones", () => {
  const re =
    /^const\s+(?:float|vec3)\s+(CELESTIAL_[A-Z0-9_]+)\s*=\s*([^;]+);/gm;
  const found = {};
  let m;
  while ((m = re.exec(globeGlsl)) !== null) {
    found[m[1]] = evaluate(
      parseExpression(tokenize(m[2].replace(/\bvec3\b/g, "vec3")), 0).node,
      {},
    );
  }
  assert.ok(
    Object.keys(found).length >= 8,
    `expected the reduced twin's constant block, found ${Object.keys(found).length}`,
  );
  for (const [name, value] of Object.entries(found)) {
    assert.deepEqual(
      value,
      EXPECTED_CONSTANTS[name],
      `${name} differs from the value the other copies use`,
    );
  }
  // The Moon's angular radius is a constant here and a uniform there, so this
  // is the one place the two representations meet; it is the whole reason the
  // GLSL twin can drift silently, and the reason it is checked.
  assert.equal(
    found.CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
    CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
    "the GLSL constant must equal the number the WebGPU packer sends",
  );
});

test("E4 the WebGL twin is the moonglade only, by ruling", () => {
  // R-2026-08-28-11 item 2: the GLSL twin carries the moon glint; the day glint
  // stays WebGPU-first. So the GLSL must NOT grow a solar microfacet term, and
  // must keep the shininess-10 Phong sun lobe it has always had.
  const twin = extractGlslFunction(
    globeGlsl,
    "computeCelestialWaterMoonSpecular",
  ).body;
  assert.ok(
    twin.includes("czm_moonDirectionEC"),
    "the twin must reflect the Moon",
  );
  assert.ok(
    !/sunIntensity|CELESTIAL_SUN_TINT|CELESTIAL_SUN_SIN/.test(globeGlsl),
    "no solar microfacet term may appear on this backend",
  );
  assert.match(
    globeGlsl,
    /czm_getSpecular\(czm_lightDirectionEC, normalizedPositionToEyeEC, normalEC, 10\.0\)/,
    "the classic Phong sun lobe must survive untouched",
  );
});

test("E5 the twin gates the terminator on the ellipsoid up, not the wave facet", () => {
  // A wave facet tilts by tens of degrees, so gating on the perturbed normal
  // would flicker the whole ocean between day and night with the swell. In
  // `computeWaterColor` the ENU frame's third column IS the ellipsoid surface
  // normal in eye coordinates; the local `normalEC` is the perturbed one.
  const call = /color \+= computeCelestialWaterMoonSpecular\(([^;]*)\);/.exec(
    globeGlsl,
  );
  assert.ok(call !== null, "the twin must be called");
  const args = call[1].split(",").map((a) => a.trim());
  assert.equal(args.length, 6, "the call must pass all six arguments");
  assert.equal(args[0], "normalEC", "the lobe rides the perturbed normal");
  assert.equal(
    args[3],
    "enuToEye[2]",
    "the gate must read the frame's own up column",
  );
  // And the WGSL twin passes its own unperturbed normal for the same argument.
  // Only the two call sites, never the definition: the definition's own
  // parameter list runs on into the body before the first semicolon.
  const wgslCalls = [
    ...globeStripped.matchAll(
      /(?:oceanContribution|classicColor) \+= computeCelestialWaterSpecular\(\s*([\s\S]*?)\);/g,
    ),
  ];
  assert.equal(wgslCalls.length, 2, "both arms must call it");
  for (const c of wgslCalls) {
    const wargs = c[1].split(",").map((a) => a.trim());
    assert.equal(
      wargs[0],
      "waterNormal",
      "the lobe rides the perturbed normal",
    );
    assert.equal(wargs[3], "normalEC", "the gate reads the analytic up");
  }
});

test("E7 with the feature off, the GLSL the driver compiles is upstream's", () => {
  // Everything the twin adds — the uniform, the constants, the four functions,
  // the call — must live inside `#ifdef APPLY_CELESTIAL_WATER`. If any of it
  // sat outside, a globe with the feature off would compile a shader that is no
  // longer upstream's, which is the bound the row was armed under. The JS-side
  // `czm_` scanner still emits a `czm_moonDirectionEC` declaration into the
  // raw source either way — it reads inactive #ifdef bodies too — but that is
  // this file's existing idiom (`czm_getWaterNoise` is named only under
  // SHOW_OCEAN_WAVES) and an unused uniform never becomes an active one.
  const lines = globeGlsl.split("\n");
  const insideDefine = [];
  let depth = 0;
  let opened = 0;
  for (const line of lines) {
    const directive = line.trim();
    if (/^#(if|ifdef|ifndef)\b/.test(directive)) {
      depth += 1;
      if (directive === "#ifdef APPLY_CELESTIAL_WATER") {
        opened = depth;
      }
      insideDefine.push(opened > 0);
      continue;
    }
    if (/^#endif\b/.test(directive)) {
      insideDefine.push(opened > 0);
      if (opened === depth) {
        opened = 0;
      }
      depth -= 1;
      continue;
    }
    insideDefine.push(opened > 0);
  }
  const NEEDLES = [
    "uniform vec4 u_oceanCelestialMoon;",
    "const float CELESTIAL_WATER_F0",
    "const vec3 CELESTIAL_MOON_TINT",
    "float celestialNightGate(",
    "float celestialDistributionGGX(",
    "float celestialSmithG1(",
    "float celestialGlint(",
    "vec3 computeCelestialWaterMoonSpecular(",
    "color += computeCelestialWaterMoonSpecular(",
  ];
  for (const needle of NEEDLES) {
    const index = lines.findIndex((l) => l.includes(needle));
    assert.ok(index >= 0, `${needle} must exist`);
    assert.ok(
      insideDefine[index],
      `"${needle}" sits outside #ifdef APPLY_CELESTIAL_WATER — the off source is no longer upstream's`,
    );
  }
  // And the composition itself is untouched: upstream's two arms, verbatim.
  assert.match(
    globeGlsl,
    /vec3 color = imageryColor\.rgb \+ diffuseHighlight \+ nonDiffuseHighlight \+ specular;/,
    "the non-HDR composition must be upstream's, unchanged",
  );
  assert.match(
    globeGlsl,
    /vec3 color = imageryColor\.rgb \+ \(c \* \(vec3\(e\) \+ imageryColor\.rgb \* d\) \* \(diffuseHighlight \+ nonDiffuseHighlight \+ specular\)\);/,
    "the HDR composition must be upstream's, unchanged",
  );
});

/**
 * Compile the GLSL twin's own functions into callables.
 *
 * Every other check on the WebGL half is a text comparison: E1 holds its four
 * shared functions equal to the WGSL, E5 reads its call-site arguments, E7
 * proves containment. None of that EXECUTES the reduced composer
 * computeCelestialWaterMoonSpecular, which is GLSL-only and so falls outside
 * the four-function equality contract — and that function is where the ruled
 * WebGL half of the feature actually lives. Defeating its night gate leaves
 * every text check green while putting the moonglade on the water at noon.
 *
 * So the GLSL is executed here. The dialect transform is mechanical and
 * narrow: a leading declaration type before an assigned identifier becomes a
 * binding keyword, and nothing else changes — same operands, same calls, same
 * order. It is the executable sibling of canonicalise, which does the same job
 * for comparison rather than for evaluation, and it fails closed: anything the
 * evaluator cannot read throws rather than being quietly skipped.
 *
 * @param {string} glsl The GLSL source to read the functions out of.
 * @returns {object} The callables and the globals they close over.
 */
function glslLawFrom(glsl) {
  const constants = {};
  const re =
    /^const\s+(?:float|vec3)\s+(CELESTIAL_[A-Z0-9_]+)\s*=\s*([^;]+);/gm;
  let m;
  while ((m = re.exec(glsl)) !== null) {
    constants[m[1]] = evaluate(parseExpression(tokenize(m[2]), 0).node, {});
  }
  // czm_pi is a Cesium builtin the shader receives by declaration injection,
  // so it has no const line here to read. It is the same number the WGSL twin
  // spells PI, which C1 and D2 already hold to its value.
  constants.czm_pi = GLOBE_CONSTANTS.PI;

  const functions = {};
  const globals = { ...constants, __functions: functions };
  for (const name of [
    "celestialNightGate",
    "celestialDistributionGGX",
    "celestialSmithG1",
    "celestialGlint",
    "computeCelestialWaterMoonSpecular",
  ]) {
    const { params, body } = extractGlslFunction(glsl, name);
    const evaluable = body
      .replace(/\/\/[^\n]*/g, "")
      .replace(
        /\b(?:float|vec2|vec3|vec4)\s+(?=[A-Za-z_][A-Za-z0-9_]*\s*=)/g,
        "let ",
      );
    functions[name] = compileFunction(
      `fn ${name}(${params.join(", ")}) -> f32 {${evaluable}}`,
      name,
      globals,
    );
  }
  return { constants, functions, globals };
}

/**
 * The reduced twin's moon term for one sun altitude, executed out of GLSL.
 *
 * @param {object} law The result of glslLawFrom.
 * @param {number} sunAltitude Sine of the Sun's altitude against the up axis.
 * @param {object} [overrides] Uniform overrides.
 * @returns {number} The red channel of the returned term.
 */
function glslMoonTerm(law, sunAltitude, overrides = {}) {
  const moon = dir(Math.PI / 3, Math.PI);
  const view = dir(Math.PI / 3, 0);
  law.globals.czm_moonDirectionEC = moon;
  law.globals.u_oceanCelestialMoon = {
    x: overrides.roughness ?? 0.06,
    y: overrides.moonIntensity ?? 1.0,
    z: overrides.moonPhase ?? 1.0,
    w: 0.0,
  };
  try {
    return law.functions.computeCelestialWaterMoonSpecular(
      UP,
      view,
      vec(0, 0, sunAltitude),
      UP,
      overrides.waveIntensity ?? 1.0,
      overrides.mask ?? 1.0,
    ).x;
  } finally {
    delete law.globals.czm_moonDirectionEC;
    delete law.globals.u_oceanCelestialMoon;
  }
}
test("E6 the GLSL define is emitted only with the water it shades", () => {
  assert.match(
    shaderSetJs,
    /if \(applyCelestialWater\) \{\s*fs\.defines\.push\("APPLY_CELESTIAL_WATER"\);/,
    "the define must ride the surface-shader family",
  );
  // Its own bit, add-only, above the last one taken.
  assert.match(
    shaderSetJs,
    /\(applyNightLights \? 0x1000000000 : 0\) \+\s*\(applyCelestialWater \? 0x2000000000 : 0\)/,
    "the define must contribute a distinct bit to the shader key",
  );
  assert.match(
    renderingJs,
    /surfaceShaderSetOptions\.applyCelestialWater =\s*celestialTail\.enable > 0\.0 && showReflectiveOcean;/,
    "the define must be conjoined with the reflective-ocean condition",
  );
});

/**
 * Body text of a WGSL function, by name.
 *
 * @param {string} src Stripped WGSL.
 * @param {string} name The function name.
 * @returns {string} The body.
 */
function compileFunctionBody(src, name) {
  const at = src.search(new RegExp(`\\bfn\\s+${name}\\s*\\(`));
  assert.ok(at >= 0, `WGSL function ${name} not found`);
  const brace = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  let i = brace;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(brace + 1, i);
}

/**
 * Parameter names of a WGSL function, by name.
 *
 * @param {string} src Stripped WGSL.
 * @param {string} name The function name.
 * @returns {string[]} The parameter names.
 */
function extractWgslParams(src, name) {
  const at = src.search(new RegExp(`\\bfn\\s+${name}\\s*\\(`));
  assert.ok(at >= 0, `WGSL function ${name} not found`);
  const open = src.indexOf("(", at);
  let depth = 0;
  let i = open;
  for (; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src
    .slice(open + 1, i)
    .split(",")
    .map((p) => p.split(":")[0].trim())
    .filter((p) => p.length > 0);
}

test("E8 the WebGL twin's night gate is EXECUTED, not read", () => {
  // The one behaviour no text check can see: a moonglade that survives
  // daylight. The Moon is up and full in both cases; only the Sun moves.
  const law = glslLawFrom(globeGlsl);
  assert.equal(
    glslMoonTerm(law, 0.5),
    0,
    "a Moon overhead at midday must reflect nothing",
  );
  assert.ok(
    glslMoonTerm(law, -0.5) > 0,
    "and the same Moon on the night side must reflect something",
  );
  // The handover has a band, not an edge: closed above it, open below it,
  // and the same three-degree half-width the WGSL twin uses.
  const band = EXPECTED_CONSTANTS.CELESTIAL_NIGHT_BAND_SIN;
  assert.equal(glslMoonTerm(law, band), 0, "closed at the top of the band");
  assert.ok(glslMoonTerm(law, -band) > 0, "open at the bottom of the band");
  const horizon = glslMoonTerm(law, 0);
  assert.ok(
    horizon > 0 && horizon < glslMoonTerm(law, -band),
    "and half-open at the geometric horizon",
  );
});

test("E9 the executed twin also carries its phase, rise and mask weights", () => {
  const law = glslLawFrom(globeGlsl);
  const night = glslMoonTerm(law, -0.5);
  assert.ok(
    Math.abs(glslMoonTerm(law, -0.5, { moonPhase: 0.5 }) - night * 0.5) < 1e-12,
    "the illuminated fraction must scale the term linearly",
  );
  assert.equal(
    glslMoonTerm(law, -0.5, { moonPhase: 0 }),
    0,
    "a new Moon must reflect nothing",
  );
  assert.ok(
    Math.abs(glslMoonTerm(law, -0.5, { mask: 0.25 }) - night * 0.25) < 1e-12,
    "the water mask must scale the whole term",
  );
  assert.equal(
    glslMoonTerm(law, -0.5, { mask: 0 }),
    0,
    "dry land must reflect nothing",
  );
  assert.ok(
    glslMoonTerm(law, -0.5, { waveIntensity: 0 }) < night,
    "the far band must be dimmer on axis than the near water",
  );
});

test("E10 INERTNESS — the twin's night gate defeated in place", () => {
  // The mutation that motivated E8: every symbol still present, the function
  // still called with the same arguments, every text check still green, and
  // the moonglade on the water in broad daylight.
  const inert = globeGlsl.replace(
    "    float nightGate = celestialNightGate(upEC, sunDirEC);",
    "    float nightGate = 1.0;",
  );
  assert.notEqual(inert, globeGlsl, "the mutation must apply");
  assert.ok(
    glslMoonTerm(glslLawFrom(inert), 0.5) > 0,
    "the defeated gate must let the moonglade through at midday; if this is 0, E8 cannot fail and the hole is still open",
  );
  assert.equal(
    glslMoonTerm(glslLawFrom(globeGlsl), 0.5),
    0,
    "and the shipped law must still close it",
  );
});
// ───────── F. the CPU law, executed ────────────────────────────────────────

test("F1 off resolves every field to exact positive zero", () => {
  const tail = resolveCelestialWaterTail(
    {
      enabled: false,
      roughness: 0.4,
      sunIntensity: 3,
      moonIntensity: 9,
    },
    { x: 1, y: 0, z: 0 },
    1.0,
  );
  for (const [key, value] of Object.entries(tail)) {
    if (key === "moonDirection") {
      for (const axis of ["x", "y", "z"]) {
        assert.ok(
          Object.is(value[axis], 0),
          `moonDirection.${axis} must be positive zero, got ${value[axis]}`,
        );
      }
      continue;
    }
    assert.ok(
      Object.is(value, 0),
      `${key} must be positive zero, got ${value}`,
    );
  }
});

test("F2 only a strict true enables", () => {
  for (const enabled of [1, "true", {}, [], "yes"]) {
    assert.equal(
      resolveCelestialWaterTail({ enabled }, { x: 1, y: 0, z: 0 }, 1).enable,
      0,
      `a truthy ${JSON.stringify(enabled)} must not enable the feature`,
    );
  }
  assert.equal(resolveCelestialWaterTail({ enabled: true }).enable, 1);
  // And a missing control object is off, not a throw.
  assert.equal(resolveCelestialWaterTail(undefined).enable, 0);
});

test("F3 the controls are clamped and floored, never poisoned", () => {
  const on = (over) =>
    resolveCelestialWaterTail({ enabled: true, ...over }, undefined, undefined);
  assert.equal(on({ roughness: 0 }).roughness, 0.02, "roughness floor");
  assert.equal(on({ roughness: 5 }).roughness, 1.0, "roughness ceiling");
  assert.equal(on({ roughness: NaN }).roughness, 0.06, "non-finite falls back");
  assert.equal(
    on({ roughness: undefined }).roughness,
    0.06,
    "absent falls back",
  );
  assert.equal(on({ sunIntensity: -3 }).sunIntensity, 0, "no negative light");
  assert.equal(on({ moonIntensity: -3 }).moonIntensity, 0, "no negative light");
  assert.equal(
    on({ sunIntensity: Infinity }).sunIntensity,
    1.0,
    "a non-finite intensity falls back rather than saturating the buffer",
  );
  assert.equal(on({ moonIntensity: NaN }).moonIntensity, 0.35, "moon default");
  assert.equal(on({}).sunIntensity, 1.0, "sun default");
});

test("F4 a hidden Moon cannot steer the glint with a stale bearing", () => {
  const bearing = { x: 3, y: 4, z: 0 };
  const live = resolveCelestialWaterTail({ enabled: true }, bearing, 0.5);
  assert.ok(
    Math.abs(live.moonDirection.x - 0.6) < 1e-12,
    "unit length is this seam's job",
  );
  assert.ok(Math.abs(live.moonDirection.y - 0.8) < 1e-12);
  assert.equal(live.moonPhase, 0.5);

  for (const phase of [0, undefined, NaN, -1]) {
    const dark = resolveCelestialWaterTail({ enabled: true }, bearing, phase);
    assert.equal(dark.moonPhase, 0, `phase ${phase} must publish no Moon`);
    for (const axis of ["x", "y", "z"]) {
      assert.ok(
        Object.is(dark.moonDirection[axis], 0),
        `a hidden Moon must publish a zero bearing, not ${dark.moonDirection[axis]}`,
      );
    }
  }
  // A degenerate bearing is treated the same way.
  const degenerate = resolveCelestialWaterTail(
    { enabled: true },
    { x: 0, y: 0, z: 0 },
    1,
  );
  assert.equal(degenerate.moonPhase, 0);
});

test("F5 the phase is capped at a full disc", () => {
  assert.equal(
    resolveCelestialWaterTail({ enabled: true }, { x: 0, y: 0, z: 1 }, 4)
      .moonPhase,
    1,
  );
});

test("F6 the angular radii are the bodies', not the caller's", () => {
  const tail = resolveCelestialWaterTail(
    { enabled: true },
    { x: 0, y: 0, z: 1 },
    1,
  );
  assert.equal(tail.sinAngularRadius, 0.0046524);
  assert.equal(tail.moonSinAngularRadius, 0.0045213);
  // And they are the same numbers the shader carries.
  assert.equal(
    tail.moonSinAngularRadius,
    CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
    "the packed radius must be the module's own constant",
  );
  assert.equal(tail.sinAngularRadius, CELESTIAL_SUN_SIN_ANGULAR_RADIUS);
});

test("F7 both backends resolve through the one law", () => {
  assert.match(
    cameraUbTs,
    /import \{ resolveCelestialWaterTail \} from "\.\.\/\.\.\/Scene\/CelestialWaterReflection\.js";/,
    "the WebGPU camera-UB packer must use the shared resolver",
  );
  assert.match(
    renderingJs,
    /import \{ resolveCelestialWaterTail \} from "\.\/CelestialWaterReflection\.js";/,
    "the WebGL tile-command path must use the shared resolver",
  );
  // Neither may re-derive a clamp of its own.
  for (const [label, src] of [
    ["camera UB", cameraUbTs],
    ["tile rendering", renderingJs],
  ]) {
    assert.ok(
      !/CELESTIAL_MIN_ROUGHNESS|CELESTIAL_MAX_ROUGHNESS/.test(src),
      `${label} must not carry its own copy of the clamp range`,
    );
  }
});

test("F8 the WebGPU packer asks for the Moon in the frame its shader shades in", () => {
  const call = /resolveCelestialWaterTail\(([\s\S]*?)\n {2}\);/.exec(
    cameraUbTs,
  );
  assert.ok(call !== null, "the packer must call the resolver");
  assert.ok(
    call[1].includes("uniformState?.moonDirectionEC"),
    "the globe shades in eye coordinates, so the Moon must arrive in eye coordinates",
  );
  assert.ok(
    !call[1].includes("moonDirectionWC"),
    "a world-space bearing here would steer the glint into the wrong hemisphere",
  );
  // The FFT surface, which shades in world space, asks for the other one.
  const ocean = read(
    path.join(ROOT, "packages/engine/Source/Scene/OceanSurfacePrimitive.js"),
  );
  assert.match(
    ocean,
    /frameState\?\.moonDirectionWC/,
    "the FFT surface shades in world space and must ask for the world bearing",
  );
});

test("F9 the tail is written once per slot, in the struct's own order", () => {
  const writer = /export function writeCelestialWaterTail\([\s\S]*?\n\}/.exec(
    cameraUbTs,
  );
  assert.ok(writer !== null, "the writer must exist");
  const assignments = [
    ...writer[0].matchAll(/data\[offset \+ (\d+)\] = ([^;]+);/g),
  ];
  assert.equal(assignments.length, 12, "twelve floats, twelve writes");
  assert.deepEqual(
    assignments.map((a) => Number(a[1])),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "each slot must be written exactly once, in order",
  );
  assert.deepEqual(
    assignments.map((a) => a[2].trim()),
    [
      "tail.enable",
      "tail.roughness",
      "tail.sunIntensity",
      "tail.sinAngularRadius",
      "tail.moonDirection.x",
      "tail.moonDirection.y",
      "tail.moonDirection.z",
      "tail.moonPhase",
      "tail.moonIntensity",
      "tail.moonSinAngularRadius",
      "0.0",
      "0.0",
    ],
    "the packing order must match the WGSL struct",
  );
});

test("F10 the public switch is off by default on both surfaces", () => {
  assert.match(
    globeJs,
    /this\.oceanCelestialReflection = false;/,
    "the globe switch must default off",
  );
  // The three dials are imported from the module that owns them rather than
  // restated here, so what this pins is that they ARE single-sourced and that
  // the shared values are the documented ones. Restating the literals would
  // reintroduce the fourth copy the shared module exists to remove.
  for (const [property, constant] of [
    ["oceanCelestialRoughness", "CELESTIAL_DEFAULT_ROUGHNESS"],
    ["oceanCelestialSunIntensity", "CELESTIAL_DEFAULT_SUN_INTENSITY"],
    ["oceanCelestialMoonIntensity", "CELESTIAL_DEFAULT_MOON_INTENSITY"],
  ]) {
    assert.match(
      globeJs,
      new RegExp(`this\\.${property} = ${constant};`),
      `${property} must take its default from the shared module`,
    );
  }
  assert.match(
    globeJs,
    /from "\.\/CelestialWaterReflection\.js";/,
    "and must import them rather than declaring its own",
  );
  assert.equal(CELESTIAL_DEFAULT_ROUGHNESS, 0.06);
  assert.equal(CELESTIAL_DEFAULT_SUN_INTENSITY, 1.0);
  assert.equal(CELESTIAL_DEFAULT_MOON_INTENSITY, 0.35);
  // And it is mirrored raw onto the tile provider, enable and dials apart.
  for (const name of [
    "oceanCelestialReflection",
    "oceanCelestialRoughness",
    "oceanCelestialSunIntensity",
    "oceanCelestialMoonIntensity",
  ]) {
    assert.ok(
      new RegExp(`tileProvider\\.${name} =`).test(globeJs),
      `${name} must be mirrored onto the tile provider`,
    );
  }
});

// ───────── G. MUTANTS — one source substituted, nothing written ─────────────
//
// Every mutant below replaces ONE file's text for the length of one verdict and
// puts it back. Nothing is written to disk, deliberately: several specs in this
// fleet read these same files at module load, so a mutant that wrote one would
// race any concurrent run and hand another spec a source neither of them chose.
// G13 checks that nothing moved.
//
// The verdict is not a re-reading of the assertions above. It RECOMPILES the
// celestial law out of whatever text it is handed and executes it, so an
// arithmetic mutation flips it even though every symbol is still present; it
// re-derives the cross-language equality, so a mutation to EITHER copy flips
// it; and it re-reads the seams. G12's control changes a comment and must NOT
// flip it, which is what separates a discriminating mutant from a destructive
// one.

const MUTABLE_PATHS = {
  globeWgsl: GLOBE_WGSL_PATH,
  globeGlsl: GLOBE_GLSL_PATH,
  cameraUb: CAMERA_UB_PATH,
  types: TYPES_PATH,
  rendering: RENDERING_PATH,
};

const sourcesOnDisk = new Map();
for (const file of Object.values(MUTABLE_PATHS)) {
  sourcesOnDisk.set(file, fs.readFileSync(file));
}

/**
 * Recompile the celestial law out of arbitrary WGSL text and return the
 * callables plus the constant table.
 *
 * @param {string} text The WGSL source.
 * @returns {object} The law.
 */
function lawFrom(text) {
  const stripped = stripComments(text);
  const start = stripped.indexOf("const CELESTIAL_WATER_F0");
  const end = stripped.indexOf("fn computeEnhancedOcean");
  const pi = /^const PI: f32 = [^;]+;/m.exec(stripped);
  const constants = readConstants(`${pi[0]}\n${stripped.slice(start, end)}`);
  const functions = {};
  const globals = { ...constants, __functions: functions };
  for (const name of [
    "celestialNightGate",
    "celestialDistributionGGX",
    "celestialSmithG1",
    "celestialGlint",
    "computeCelestialWaterSpecular",
  ]) {
    functions[name] = compileFunction(stripped, name, globals);
  }
  return { constants, functions, globals, stripped };
}

/**
 * Evaluate the law's whole contribution for one configuration.
 *
 * @param {object} law The result of {@link lawFrom}.
 * @param {object} lanes Camera lanes.
 * @param {object} sunDir The Sun's direction.
 * @param {object} view The view direction.
 * @param {number} mask The water mask value.
 * @returns {number} The red channel of the contribution.
 */
function contribution(law, lanes, sunDir, view, mask) {
  law.globals.camera = lanes;
  try {
    return law.functions.computeCelestialWaterSpecular(
      UP,
      view,
      sunDir,
      UP,
      1.0,
      mask,
    ).x;
  } finally {
    delete law.globals.camera;
  }
}

/**
 * The whole port as one predicate over a set of sources.
 *
 * @param {{file: string, text: string}} [override] One substituted source.
 * @returns {boolean} Whether the port still holds.
 */
function verdict(override) {
  const source = (file) =>
    override?.file === file
      ? override.text
      : sourcesOnDisk.get(file).toString("utf8").replace(/\r\n/g, "\n");
  try {
    const wgsl = source(GLOBE_WGSL_PATH);
    const glsl = source(GLOBE_GLSL_PATH);
    const ub = source(CAMERA_UB_PATH);
    const types = source(TYPES_PATH);
    const rendering = source(RENDERING_PATH);

    // 1. The port reached both arms — the classic one especially, since that is
    //    the arm a default globe compiles.
    const fn = wgsl.slice(wgsl.indexOf("fn computeEnhancedOcean"));
    const elseAt = fn.indexOf("//>>else");
    const endAt = fn.indexOf("//>>endif");
    if (elseAt < 0 || endAt < elseAt) {
      return false;
    }
    if (
      !fn
        .slice(0, elseAt)
        .includes("oceanContribution += computeCelestialWaterSpecular(")
    ) {
      return false;
    }
    const classicArm = fn.slice(elseAt, endAt);
    if (
      !classicArm.includes("classicColor += computeCelestialWaterSpecular(")
    ) {
      return false;
    }
    if (!/return classicColor;/.test(classicArm)) {
      return false;
    }

    // 2. The law, recompiled from this text and executed. Day shows the Sun and
    //    not the Moon; night shows the Moon and not the Sun; the horizon and
    //    the mask close it; and the dials scale it exactly.
    const law = lawFrom(wgsl);
    const mirror = dir(Math.PI / 3, Math.PI);
    const view = dir(Math.PI / 3, 0);
    const day = vec(0, 0, 0.5);
    const night = vec(0, 0, -0.5);
    const sunOnly = cameraLanes({
      sunIntensity: 1,
      moonIntensity: 0,
      moonDirection: mirror,
      moonPhase: 1,
    });
    const moonOnly = cameraLanes({
      sunIntensity: 0,
      moonIntensity: 1,
      moonDirection: mirror,
      moonPhase: 1,
    });
    if (!(contribution(law, sunOnly, mirror, view, 1) > 0)) {
      return false;
    }
    if (contribution(law, moonOnly, day, view, 1) !== 0) {
      return false;
    }
    const moonAtNight = contribution(law, moonOnly, night, view, 1);
    if (!(moonAtNight > 0)) {
      return false;
    }
    if (contribution(law, moonOnly, night, view, 0) !== 0) {
      return false;
    }
    // Linearity in the mask, the phase and the intensity: a coefficient that
    // stopped being a plain factor shows up here.
    if (
      Math.abs(
        contribution(law, moonOnly, night, view, 0.5) - moonAtNight * 0.5,
      ) > 1e-12
    ) {
      return false;
    }
    const halfPhase = cameraLanes({
      sunIntensity: 0,
      moonIntensity: 1,
      moonDirection: mirror,
      moonPhase: 0.5,
    });
    if (
      Math.abs(
        contribution(law, halfPhase, night, view, 1) - moonAtNight * 0.5,
      ) > 1e-12
    ) {
      return false;
    }
    const doubled = cameraLanes({
      sunIntensity: 0,
      moonIntensity: 2,
      moonDirection: mirror,
      moonPhase: 1,
    });
    if (
      Math.abs(contribution(law, doubled, night, view, 1) - moonAtNight * 2) >
      1e-12
    ) {
      return false;
    }
    // A source below the horizon reflects nothing, whichever side is below.
    const below = dir(Math.PI * 0.75, Math.PI);
    if (
      law.functions.celestialGlint(UP, view, below, 0.06, 0.0045) !== 0 ||
      law.functions.celestialGlint(UP, below, mirror, 0.06, 0.0045) !== 0
    ) {
      return false;
    }

    // 3. The three copies are one law. A mutation to any of them lands here.
    for (const name of SHARED_WGSL_FUNCTIONS) {
      const a = canonicalise(compileFunctionBody(law.stripped, name), "wgsl");
      const b = canonicalise(compileFunctionBody(oceanStripped, name), "wgsl");
      const c = canonicalise(extractGlslFunction(glsl, name).body, "glsl");
      if (a !== b || a !== c) {
        return false;
      }
    }
    const glslConstants = {};
    const re =
      /^const\s+(?:float|vec3)\s+(CELESTIAL_[A-Z0-9_]+)\s*=\s*([^;]+);/gm;
    let m;
    while ((m = re.exec(glsl)) !== null) {
      glslConstants[m[1]] = evaluate(
        parseExpression(tokenize(m[2]), 0).node,
        {},
      );
    }
    if (Object.keys(glslConstants).length < 8) {
      return false;
    }
    for (const [name, value] of Object.entries(glslConstants)) {
      const expected =
        law.constants[name] ??
        (name === "CELESTIAL_MOON_SIN_ANGULAR_RADIUS"
          ? CELESTIAL_MOON_SIN_ANGULAR_RADIUS
          : undefined);
      if (JSON.stringify(value) !== JSON.stringify(expected)) {
        return false;
      }
    }

    // 4. The GLSL twin gates on the frame's up column, not the wave facet.
    const call = /color \+= computeCelestialWaterMoonSpecular\(([^;]*)\);/.exec(
      glsl,
    );
    if (call === null) {
      return false;
    }
    const args = call[1].split(",").map((a) => a.trim());
    if (
      args.length !== 6 ||
      args[0] !== "normalEC" ||
      args[3] !== "enuToEye[2]"
    ) {
      return false;
    }

    // 5. The seams: the packing order, the frame the Moon arrives in, the
    //    declared width and the define's condition.
    const writer = /export function writeCelestialWaterTail\([\s\S]*?\n\}/.exec(
      ub,
    );
    if (writer === null) {
      return false;
    }
    const slots = [
      ...writer[0].matchAll(/data\[offset \+ (\d+)\] = ([^;]+);/g),
    ];
    const expectedSlots = [
      "tail.enable",
      "tail.roughness",
      "tail.sunIntensity",
      "tail.sinAngularRadius",
      "tail.moonDirection.x",
      "tail.moonDirection.y",
      "tail.moonDirection.z",
      "tail.moonPhase",
      "tail.moonIntensity",
      "tail.moonSinAngularRadius",
      "0.0",
      "0.0",
    ];
    if (slots.length !== 12) {
      return false;
    }
    for (let i = 0; i < 12; i += 1) {
      if (
        Number(slots[i][1]) !== i ||
        slots[i][2].trim() !== expectedSlots[i]
      ) {
        return false;
      }
    }
    if (
      !ub.includes("uniformState?.moonDirectionEC") ||
      ub.includes("frameState?.moonDirectionWC")
    ) {
      return false;
    }
    const declared = /export const CAMERA_UNIFORM_FLOATS = (\d+);/.exec(types);
    const width = /export const CELESTIAL_WATER_FLOATS = (\d+);/.exec(ub);
    if (declared === null || width === null) {
      return false;
    }
    if (Number(declared[1]) !== 232 + Number(width[1])) {
      return false;
    }
    return /surfaceShaderSetOptions\.applyCelestialWater =\s*celestialTail\.enable > 0\.0 && showReflectiveOcean;/.test(
      rendering,
    );
  } catch {
    // A law that no longer compiles, or an extraction that no longer finds its
    // function, is a failed verdict — not an error in the harness.
    return false;
  }
}

/**
 * Substitute one file's text for the length of one verdict.
 *
 * The needle is matched against the file normalised to bare newlines, because
 * this tree is CRLF and a needle written with bare newlines would otherwise
 * never match — reporting a green the mutant never earned.
 *
 * @param {string} file The absolute path.
 * @param {string} from The text to replace.
 * @param {string} to The replacement.
 * @param {boolean} expectation What the verdict must become.
 * @returns {void}
 */
function withMutation(file, from, to, expectation) {
  const text = sourcesOnDisk.get(file).toString("utf8").replace(/\r\n/g, "\n");
  assert.ok(
    text.includes(from),
    `mutation precondition failed in ${path.basename(file)}: "${from.slice(0, 70)}..."`,
  );
  assert.equal(
    verdict({ file, text: text.replace(from, to) }),
    expectation,
    `mutant in ${path.basename(file)} did not move the verdict to ${expectation}`,
  );
}

test("G0 the verdict is TRUE on the shipped tree", () => {
  assert.equal(
    verdict(undefined),
    true,
    "a verdict that is already false proves nothing about the mutants below",
  );
});

test("G1 ABSENCE — the classic arm's call deleted", () => {
  withMutation(
    GLOBE_WGSL_PATH,
    "    classicColor += computeCelestialWaterSpecular(",
    "    classicColor += vec3<f32>(0.0) * vec3<f32>(",
    false,
  );
});

test("G2 ABSENCE — the enhanced arm's call deleted", () => {
  withMutation(
    GLOBE_WGSL_PATH,
    "    oceanContribution += computeCelestialWaterSpecular(",
    "    oceanContribution += vec3<f32>(0.0) * vec3<f32>(",
    false,
  );
});

test("G3 INERTNESS — the contribution computed and thrown away", () => {
  // Every symbol is still present, the gate is still live, the function still
  // returns a colour, and nothing reflects. A deletion mutant misses this shape.
  withMutation(
    GLOBE_WGSL_PATH,
    "  return (sunContribution + moonContribution) * waterMaskValue;",
    "  return (sunContribution + moonContribution) * waterMaskValue * 0.0;",
    false,
  );
});

test("G4 WRONG SIGN — the day gate stops being the night gate's complement", () => {
  withMutation(
    GLOBE_WGSL_PATH,
    "  let dayGate = 1.0 - nightGate;",
    "  let dayGate = nightGate;",
    false,
  );
});

test("G5 WRONG SIGN — the terminator ramp inverted", () => {
  withMutation(
    GLOBE_WGSL_PATH,
    "  return 1.0 - smoothstep(\n    -CELESTIAL_NIGHT_BAND_SIN, CELESTIAL_NIGHT_BAND_SIN, sunAltitude);",
    "  return smoothstep(\n    -CELESTIAL_NIGHT_BAND_SIN, CELESTIAL_NIGHT_BAND_SIN, sunAltitude);",
    false,
  );
});

test("G6 DRIFT — the WebGL twin's distribution changed", () => {
  withMutation(
    GLOBE_GLSL_PATH,
    "    return a2 / max(czm_pi * d * d, 1.0e-8);",
    "    return a2 / max(2.0 * czm_pi * d * d, 1.0e-8);",
    false,
  );
});

test("G7 DRIFT — the WebGL twin's rise gate widened", () => {
  withMutation(
    GLOBE_GLSL_PATH,
    "const float CELESTIAL_MOON_RISE_SIN = 0.0871557;",
    "const float CELESTIAL_MOON_RISE_SIN = 0.5;",
    false,
  );
});

test("G8 LANE SWAP — the Moon's intensity and radius exchanged in the packer", () => {
  withMutation(
    CAMERA_UB_PATH,
    "  data[offset + 8] = tail.moonIntensity;\n  data[offset + 9] = tail.moonSinAngularRadius;",
    "  data[offset + 8] = tail.moonSinAngularRadius;\n  data[offset + 9] = tail.moonIntensity;",
    false,
  );
});

test("G9 FRAME SWAP — the Moon packed in world space for an eye-space shader", () => {
  withMutation(
    CAMERA_UB_PATH,
    "    uniformState?.moonDirectionEC,",
    "    frameState?.moonDirectionWC,",
    false,
  );
});

test("G10 UP SWAP — the WebGL twin gated on the wave facet", () => {
  withMutation(
    GLOBE_GLSL_PATH,
    "czm_lightDirectionEC, enuToEye[2], waveIntensity, maskValue);",
    "czm_lightDirectionEC, normalEC, waveIntensity, maskValue);",
    false,
  );
});

test("G11 UNREACHABLE — the WebGL define emitted without its water", () => {
  withMutation(
    RENDERING_PATH,
    "      celestialTail.enable > 0.0 && showReflectiveOcean;",
    "      celestialTail.enable > 0.0;",
    false,
  );
});

test("G12 WIDTH — the declared float count left behind the tail", () => {
  withMutation(
    TYPES_PATH,
    "export const CAMERA_UNIFORM_FLOATS = 244;",
    "export const CAMERA_UNIFORM_FLOATS = 232;",
    false,
  );
});

test("G13 the mutants are discriminating, not merely destructive", () => {
  // A control: a change that alters no behaviour must NOT flip the verdict, or
  // the mutants above would only be proving that the verdict is fragile.
  withMutation(
    GLOBE_WGSL_PATH,
    "// GGX/Trowbridge-Reitz normal distribution.\nfn celestialDistributionGGX",
    "// GGX/Trowbridge-Reitz normal distribution (Walter 2007).\nfn celestialDistributionGGX",
    true,
  );
  withMutation(
    GLOBE_GLSL_PATH,
    "// GGX/Trowbridge-Reitz normal distribution.\nfloat celestialDistributionGGX",
    "// GGX/Trowbridge-Reitz normal distribution (Walter 2007).\nfloat celestialDistributionGGX",
    true,
  );
});

test("G14 no source file was written — every mutation was a substitution", () => {
  for (const [file, before] of sourcesOnDisk) {
    assert.ok(
      before.equals(fs.readFileSync(file)),
      `${path.basename(file)} was modified on disk; mutants must substitute in memory`,
    );
  }
});
