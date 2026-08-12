// globe-daynight-ramp-law.spec.mjs — CLT-B4 / CO-18, DEFERRED_WORK row
// `NEW-WEBGPU-GLOBE-DAYNIGHT-RAMP-OFFSET`, CELESTIAL_LIGHT_TRANSPORT_PLAN
// 2026-08-07 §2 bug 2 and §4 row CLT-B4.
//
// WHAT THIS ROW RECONCILED. `GlobeFS.glsl` has always carried TWO DISTINCT
// expressions over one `czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) *
// 5.0` core, feeding TWO consumers:
//
//   (1) the imagery day/night alpha + the night-lights emission gate —
//       `:601`  `nightBlend = 1.0 - clamp(N·L * 5.0, 0.0, 1.0)`
//   (2) the ENABLE_DAYNIGHT_SHADING diffuse —
//       `:851`  `diffuseIntensity = clamp(N·L * 5.0 + 0.3, 0.0, 1.0)`
//       `:852`  `diffuseIntensity = mix(1.0, diffuseIntensity, fade)`
//
// `GlobeTerrain.wgsl` collapsed BOTH onto one function, `clamp(N·L * 5.0 + 0.5,
// 0.0, 1.0)`, and drove the diffuse from `mix(0.025, N·L * 0.88 + 0.12,
// dayFade)` with no camera-distance term at all. Three independent divergences
// wearing one mechanism.
//
// MEASURED, NOT INFERRED. `probe-daynight-terminator-law.mjs` run 2 (tip
// `679cbf5173`), after CO-15 fixed the normal source so the ramp existed to be
// read at all:
//   lane A  WebGL day-fade at the geometric terminator 0.012, shape `glsl-law`;
//           WebGPU 0.496, shape `wgsl-offset-law`; `terminator_delta` +0.485.
//   lane D  night/day luminance ratio at 3 Mm / 25 Mm — WebGL 1.000 / 0.300,
//           WebGPU 0.312 / 0.0896.
// WebGL's two lane-D readings are expression (2)'s EXACT closed form (section
// C2 executes it): 3 Mm sits below `lightingFadeOutDistance` (π/2 × Rmin ≈
// 9.985 Mm ⇒ fade 0 ⇒ night and day both mix to 1.0 ⇒ ratio 1.000) and 25 Mm
// above `lightingFadeInDistance` (π × Rmin ≈ 19.970 Mm ⇒ fade 1 ⇒ ratio
// 0.3 / 1.0). That agreement is what licenses reading the WebGPU deficit as an
// expression difference rather than as instrument noise.
//
// WHAT THIS SPEC PINS, AND WHY IT IS NOT THE PROBE'S JOB. An Edge run says what
// the pixels did. Whether the two SOURCE FILES still express one law is
// arithmetic over text, and it is the only check that survives a red browser.
// Section A transcribes both backends' four expressions out of the shaders —
// coefficients CAPTURED from the source, never hardcoded here — and requires
// the evaluated ramps to agree over an N·L grid. Section D runs the mutants,
// including the pre-CO-18 `+0.5` form, the single-function reuse, the dropped
// camera fade, and a GLSL-SIDE mutation that proves this spec reads both files
// rather than comparing WGSL against a copy of itself.
//
// NOT byte-identical, by design: the WebGPU look moves onto WebGL's. The WebGL
// look does not move — `GlobeFS.glsl`'s expressions are untouched by CO-18
// (comments only), which is exactly why they can serve as the reference.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read is normalised to
// `\n` first — a spec anchored on a bare `\n` false-greens on a CRLF checkout.
//
// Run: node --test Tools/visual-regression/globe-daynight-ramp-law.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  computeLightingFade,
  DEFAULT_LIGHTING_FADE_IN_DISTANCE,
  DEFAULT_LIGHTING_FADE_OUT_DISTANCE,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeLightingFade.ts";

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
const FADE_LEAF_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeLightingFade.ts";
const GLOBE_PATH = "packages/engine/Source/Scene/Globe.js";
const TILE_RENDERING_PATH =
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js";

const wgsl = read(WGSL_PATH);
const glsl = read(GLSL_PATH);
const tileUb = read(TILE_UB_PATH);
const types = read(TYPES_PATH);
const fadeLeaf = read(FADE_LEAF_PATH);
const globe = read(GLOBE_PATH);
const tileRendering = read(TILE_RENDERING_PATH);

/**
 * Strip line comments so a prose mention of a formula can never satisfy a pin.
 * Both shader languages use `//`; neither file uses block comments in the
 * regions read here.
 */
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const wgslCode = stripLineComments(wgsl);
const glslCode = stripLineComments(glsl);

// ─── the four expressions, CAPTURED from the sources ─────────────────────────

/**
 * `clamp(max(N·L, 0) * scale + offset, 0, 1)` — the shape all four expressions
 * share. `czm_getLambertDiffuse` is `max(dot(L, N), 0)`, and the WGSL writes
 * that `max` out longhand, so the two sides evaluate the same function of N·L.
 */
function makeRamp({ scale, offset }) {
  return (ndotl) => {
    const lambert = ndotl > 0 ? ndotl : 0;
    const v = lambert * scale + offset;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
}

/** Parse a `* <scale>[ + <offset>]` coefficient pair out of a capture pair. */
function coefficients(match, label) {
  assert.ok(match, `${label}: expression not found in its source file`);
  const scale = Number(match[1]);
  const offset = match[2] ? Number(match[2].replace(/[^0-9.]/g, "")) : 0;
  assert.ok(Number.isFinite(scale), `${label}: unparsable scale`);
  assert.ok(Number.isFinite(offset), `${label}: unparsable offset`);
  return { scale, offset };
}

const GLSL_ALPHA_RE =
  /float nightBlend = 1\.0 - clamp\(czm_getLambertDiffuse\(czm_lightDirectionEC, normalEC\) \* ([0-9.]+)((?:\s*\+\s*[0-9.]+)?), 0\.0, 1\.0\);/;
const GLSL_DIFFUSE_RE =
  /float diffuseIntensity = clamp\(czm_getLambertDiffuse\(czm_lightDirectionEC, normalEC\) \* ([0-9.]+)((?:\s*\+\s*[0-9.]+)?), 0\.0, 1\.0\);/;
const WGSL_ALPHA_RE =
  /fn computeDayNightFade\(normalEC: vec3<f32>, sunDirEC: vec3<f32>\) -> f32 \{\s*let lambertDiffuse = max\(dot\(sunDirEC, normalEC\), 0\.0\);\s*return clamp\(lambertDiffuse \* ([0-9.]+)((?:\s*\+\s*[0-9.]+)?), 0\.0, 1\.0\);\s*\}/;
const WGSL_DIFFUSE_RE =
  /fn computeDayNightDiffuse\(normalEC: vec3<f32>, sunDirEC: vec3<f32>\) -> f32 \{\s*let lambertDiffuse = max\(dot\(sunDirEC, normalEC\), 0\.0\);\s*return clamp\(lambertDiffuse \* ([0-9.]+)((?:\s*\+\s*[0-9.]+)?), 0\.0, 1\.0\);\s*\}/;

/** The N·L grid both laws are evaluated over. Bounded: 801 points. */
const GRID = Object.freeze(
  Array.from({ length: 801 }, (_, i) => -1 + i * 0.0025),
);

/** Largest absolute disagreement between two laws over the grid. */
function maxDelta(a, b) {
  let worst = 0;
  for (const ndotl of GRID) {
    const d = Math.abs(a(ndotl) - b(ndotl));
    if (d > worst) {
      worst = d;
    }
  }
  return worst;
}

/**
 * Every predicate is a function of a (wgslSource, glslSource) pair so section D
 * can run the SAME predicates against deliberately-broken copies. A gate that
 * only ever sees the correct input certifies nothing.
 */
export function alphaRampsAgree(wgslSource, glslSource) {
  const g = GLSL_ALPHA_RE.exec(stripLineComments(glslSource));
  const w = WGSL_ALPHA_RE.exec(stripLineComments(wgslSource));
  if (!g || !w) {
    return false;
  }
  const glslLaw = makeRamp(coefficients(g, "glsl alpha"));
  const wgslLaw = makeRamp(coefficients(w, "wgsl alpha"));
  return maxDelta(glslLaw, wgslLaw) === 0;
}

export function diffuseExpressionsAgree(wgslSource, glslSource) {
  const g = GLSL_DIFFUSE_RE.exec(stripLineComments(glslSource));
  const w = WGSL_DIFFUSE_RE.exec(stripLineComments(wgslSource));
  if (!g || !w) {
    return false;
  }
  const glslLaw = makeRamp(coefficients(g, "glsl diffuse"));
  const wgslLaw = makeRamp(coefficients(w, "wgsl diffuse"));
  return maxDelta(glslLaw, wgslLaw) === 0;
}

/**
 * The two WGSL consumers take DIFFERENT functions.
 *
 * This is the single-function-reuse pin: the imagery alpha takes
 * `computeDayNightFade`, the lighting arm takes `computeDayNightDiffuse`, and
 * the lighting arm may not reference the alpha ramp at all.
 */
export function consumersAreDistinct(wgslSource) {
  const code = stripLineComments(wgslSource);
  if (
    !/dayFade = computeDayNightFade\(dayNightNormalEC, sunDir\);/.test(code)
  ) {
    return false;
  }
  if (
    !/let dayNightDiffuse = computeDayNightDiffuse\(dayNightNormalEC, sunDir\);/.test(
      code,
    )
  ) {
    return false;
  }
  // `computeDayNightFade` may be CALLED exactly once, and that one call site is
  // the imagery-alpha assignment above — so the lighting arm cannot be reusing
  // it. (The `fn ` lookbehind separates the definition from call sites.)
  const calls =
    code.match(/(?<!fn )\bcomputeDayNightFade\([^)]*\)/g)?.length ?? 0;
  return calls === 1;
}

/**
 * The diffuse expression is actually CONSUMED, not merely defined.
 *
 * Separate from `diffuseExpressionsAgree` on purpose. That predicate reads the
 * function DEFINITION, so a shader that keeps a correct `computeDayNightDiffuse`
 * and drives its lighting from something else would satisfy it — the
 * "scaffolding that computes the right thing and throws it away" failure mode.
 * Mutant D6 found exactly that hole in this spec's first draft.
 */
export function diffuseIsConsumed(wgslSource) {
  const code = stripLineComments(wgslSource);
  const calls = code.match(/(?<!fn )\bcomputeDayNightDiffuse\([^)]*\)/g) ?? [];
  return (
    calls.length === 1 &&
    /let dayNightDiffuse = computeDayNightDiffuse\(dayNightNormalEC, sunDir\);/.test(
      code,
    )
  );
}

/** The lighting arm applies GLSL:852's camera-distance mix. */
export function lightingAppliesCameraFade(wgslSource) {
  return /diffuse = mix\(\s*1\.0,\s*dayNightDiffuse,\s*clamp\(tile\.lightingFade, 0\.0, 1\.0\),?\s*\);/.test(
    stripLineComments(wgslSource),
  );
}

// ─── A. one law, transcribed out of both shaders and evaluated ───────────────

test("A1: GLSL's imagery day/night alpha ramp carries NO offset", () => {
  const c = coefficients(GLSL_ALPHA_RE.exec(glslCode), "glsl alpha");
  assert.equal(c.scale, 5.0);
  assert.equal(
    c.offset,
    0,
    "the alpha ramp must have no offset — an offset here moves the terminator",
  );
});

test("A2: GLSL's DAYNIGHT diffuse carries the +0.3 night floor and the fade mix", () => {
  const c = coefficients(GLSL_DIFFUSE_RE.exec(glslCode), "glsl diffuse");
  assert.equal(c.scale, 5.0);
  assert.equal(c.offset, 0.3);
  assert.match(
    glslCode,
    /diffuseIntensity = mix\(1\.0, diffuseIntensity, fade\);/,
    "GlobeFS.glsl:852's camera-distance mix is the second half of expression " +
      "(2); without it the night side never flat-lights near the ground",
  );
});

test("A3: the WGSL alpha ramp is GLSL's, coefficient for coefficient", () => {
  const c = coefficients(WGSL_ALPHA_RE.exec(wgslCode), "wgsl alpha");
  assert.equal(c.scale, 5.0);
  assert.equal(c.offset, 0, "the pre-CO-18 `+0.5` is what CLT-B4 removed");
});

test("A4: the WGSL diffuse is GLSL's, coefficient for coefficient", () => {
  const c = coefficients(WGSL_DIFFUSE_RE.exec(wgslCode), "wgsl diffuse");
  assert.equal(c.scale, 5.0);
  assert.equal(c.offset, 0.3);
});

test("A5: the two backends' ALPHA ramps agree exactly over the N·L grid", () => {
  assert.equal(GRID.length, 801);
  assert.equal(
    alphaRampsAgree(wgsl, glsl),
    true,
    "the imagery day/night alpha ramps disagree somewhere on [-1, 1]",
  );
  // And the value the finding was recorded at: the geometric terminator.
  const glslLaw = makeRamp(coefficients(GLSL_ALPHA_RE.exec(glslCode), "g"));
  const wgslLaw = makeRamp(coefficients(WGSL_ALPHA_RE.exec(wgslCode), "w"));
  assert.equal(glslLaw(0), 0, "day fade at N·L = 0 must be 0 (fully night)");
  assert.equal(wgslLaw(0), 0);
  assert.equal(
    wgslLaw(0) - glslLaw(0),
    0,
    "the +0.485 terminator delta lane A measured must now be 0",
  );
});

test("A6: the two backends' DIFFUSE expressions agree exactly over the N·L grid", () => {
  assert.equal(
    diffuseExpressionsAgree(wgsl, glsl),
    true,
    "the DAYNIGHT_SHADING diffuse expressions disagree somewhere on [-1, 1]",
  );
  assert.equal(
    diffuseIsConsumed(wgsl),
    true,
    "the expression must also be REACHED — a correct function the shader " +
      "never calls is scaffolding, not a law",
  );
});

test("A7: the alpha ramp and the diffuse are DISTINCT expressions on both backends", () => {
  // The whole defect was one function serving both consumers. This asserts the
  // two are genuinely different functions — so a future edit that re-merges
  // them cannot pass A5 and A6 simultaneously by accident.
  const alpha = makeRamp(coefficients(GLSL_ALPHA_RE.exec(glslCode), "g-a"));
  const diffuse = makeRamp(coefficients(GLSL_DIFFUSE_RE.exec(glslCode), "g-d"));
  assert.equal(
    diffuse(0) - alpha(0),
    0.3,
    "at the terminator the diffuse sits at its night floor while the alpha " +
      "ramp is fully night — that 0.3 gap IS the reason they are two",
  );
  assert.ok(maxDelta(alpha, diffuse) >= 0.3);
  // Both saturate to 1 on the day side, which is why the day half of a
  // rendered frame cannot discriminate them — only the night half can.
  assert.equal(alpha(0.5), 1);
  assert.equal(diffuse(0.5), 1);
});

// ─── B. each expression reaches its own consumer, and only its own ───────────

test("B1: the imagery alpha + night-lights gate take the alpha ramp", () => {
  assert.match(
    wgslCode,
    /dayFade = computeDayNightFade\(dayNightNormalEC, sunDir\);/,
  );
  assert.match(
    wgslCode,
    /nightBlend = 1\.0 - dayFade;/,
    "WGSL's nightBlend must be the alpha ramp's complement, matching " +
      "GlobeFS.glsl:601's `1.0 - clamp(...)`",
  );
});

test("B2: the DAYNIGHT lighting arm takes the diffuse expression and the fade mix", () => {
  assert.equal(consumersAreDistinct(wgsl), true);
  assert.equal(
    lightingAppliesCameraFade(wgsl),
    true,
    "the lighting arm must apply `mix(1.0, diffuse, lightingFade)` — " +
      "GlobeFS.glsl:852",
  );
});

test("B3: the lighting arm does NOT reuse the alpha ramp (the CLT-B4 defect)", () => {
  // Structural, not textual: `computeDayNightFade` has exactly ONE call site
  // and it is the imagery-alpha assignment, so no second consumer exists.
  const calls = wgslCode.match(/(?<!fn )\bcomputeDayNightFade\([^)]*\)/g) ?? [];
  assert.equal(
    calls.length,
    1,
    `computeDayNightFade has ${calls.length} call sites; exactly one is the ` +
      "reconciled shape",
  );
  // `dayFade` may still be read elsewhere (imagery layers, fog) — that is
  // WebGL's shape too. What must not happen is the DIFFUSE being derived from
  // it. Assert on the lighting arm's own text.
  const arm =
    /let dayNightDiffuse = computeDayNightDiffuse[\s\S]{0,200}?diffuse = mix\([\s\S]{0,120}?\);/.exec(
      wgslCode,
    );
  assert.ok(arm, "the DAYNIGHT lighting arm was not found");
  assert.doesNotMatch(
    arm[0],
    /dayFade/,
    "the lighting arm reads dayFade — that is the single-function reuse " +
      "CLT-B4 removed",
  );
});

test("B4: computeTerminatorGlow consumes NEITHER ramp — verified, not assumed", () => {
  // The task this row was given said to update the glow "if it consumed the old
  // centred ramp". It does not: it takes the raw SIGNED dot, so the law change
  // cannot move it. Recording the reading is what makes that a finding rather
  // than an omission.
  const fn =
    /fn computeTerminatorGlow\(normalEC: vec3<f32>, sunDirEC: vec3<f32>\) -> vec3<f32> \{[\s\S]{0,400}?\n\}/.exec(
      wgslCode,
    );
  assert.ok(fn, "computeTerminatorGlow was not found");
  assert.match(fn[0], /let NdotL = dot\(normalEC, sunDirEC\);/);
  assert.doesNotMatch(
    fn[0],
    /computeDayNightFade|computeDayNightDiffuse|clamp/,
  );
  assert.doesNotMatch(
    fn[0],
    /max\(dot/,
    "the glow peaks at N·L ≈ 0 and must see the SIGNED dot on both sides",
  );
});

// ─── C. the camera-distance fade, EXECUTED ───────────────────────────────────

test("C1: computeLightingFade transcribes all three GLSL cameraDist arms", () => {
  // Executable code is checked by running it (C2-C5); this pins that the code
  // being run is a transcription of GlobeFS.glsl:620-644 rather than a
  // convenient approximation of it.
  assert.match(
    fadeLeaf,
    /sceneMode === SceneMode\.SCENE2D/,
    "the 2D arm (frustum-plane span × 0.5) is missing",
  );
  assert.match(
    fadeLeaf,
    /camera\.frustum\?\.offCenterFrustum \?\? camera\.frustum/,
    "czm_frustumPlanes is written through offCenterFrustum " +
      "(UniformState.js:794-802); reading the outer frustum would diverge for " +
      "an OrthographicFrustum",
  );
  assert.match(
    fadeLeaf,
    /sceneMode === SceneMode\.COLUMBUS_VIEW\s*\?\s*-tz/,
    "the Columbus-View arm (-czm_view[3].z) is missing",
  );
  assert.match(
    fadeLeaf,
    /Math\.sqrt\(tx \* tx \+ ty \* ty \+ tz \* tz\)/,
    "the default arm (length(czm_view[3])) is missing",
  );
  assert.match(
    fadeLeaf,
    /if \(sceneMode !== SceneMode\.SCENE3D\) \{\s*fadeOutDist -= maximumEllipsoidRadius;\s*fadeInDist -= maximumEllipsoidRadius;/,
    "the non-3D radius reduction is missing",
  );
});

test("C2: THE DERIVATION — the law reproduces lane D's measured WebGL leg exactly", () => {
  // Globe.js:307/317 set the two distances from the ellipsoid's MINIMUM radius.
  const minimumRadius = 6356752.314245179;
  const maximumRadius = 6378137.0;
  const fadeOut = (Math.PI / 2) * minimumRadius; // ≈ 9.985 Mm
  const fadeIn = Math.PI * minimumRadius; // ≈ 19.970 Mm
  // The probe's own two altitudes (probe-daynight-terminator-law.mjs).
  const camera = (altitudeMetres) => ({
    // czm_view[3] for a camera at |p| = altitude + R. Only the magnitude
    // matters in 3D; the sign convention of the translation column does not.
    viewMatrix: { 12: 0, 13: 0, 14: -(altitudeMetres + maximumRadius) },
    frustum: {},
  });
  const fadeLow = computeLightingFade(
    3, // SceneMode.SCENE3D
    camera(3_000_000),
    fadeOut,
    fadeIn,
    maximumRadius,
  );
  const fadeHigh = computeLightingFade(
    3,
    camera(25_000_000),
    fadeOut,
    fadeIn,
    maximumRadius,
  );
  assert.equal(fadeLow, 0, "3 Mm sits BELOW fadeOutDist ⇒ fade is exactly 0");
  assert.equal(fadeHigh, 1, "25 Mm sits ABOVE fadeInDist ⇒ fade is exactly 1");

  // Now the closed form of expression (2) at lane D's two sample bands. The
  // probe's night band is N·L ≤ -0.12 and its day band N·L ≥ 0.21 — both
  // OUTSIDE both ramps, so only the lighting term can move the reading.
  const diffuse = makeRamp(coefficients(GLSL_DIFFUSE_RE.exec(glslCode), "d"));
  const mix = (a, b, t) => a + (b - a) * t;
  const nightDayRatio = (fade) =>
    mix(1, diffuse(-0.2), fade) / mix(1, diffuse(0.5), fade);

  assert.equal(
    nightDayRatio(fadeLow),
    1,
    "at fade 0 the mix pulls BOTH bands to 1.0, so the ratio is 1.000 — the " +
      "run-2 WebGL low-altitude reading, exactly",
  );
  assert.ok(
    Math.abs(nightDayRatio(fadeHigh) - 0.3) < 1e-12,
    `at fade 1 the ratio is the bare night floor over the saturated day ` +
      `value, 0.3 / 1.0 — the run-2 WebGL high-altitude reading, exactly ` +
      `(got ${nightDayRatio(fadeHigh)})`,
  );

  // THE ×0.30 ATTRIBUTION. The WebGL leg is a closed-form read of expression
  // (2) to three decimals, so the model is right; the pre-CO-18 WGSL had
  // neither the `+0.3` floor (it used 0.025) nor the fade mix, and measured
  // 0.312 / 0.0896 against these two numbers. Both WebGPU readings are now
  // produced by the SAME closed form, because the expression is the same.
  assert.equal(
    diffuse(-0.2),
    0.3,
    "0.3 is expression (2)'s night floor, and 0.3/1.0 is the ×0.30 the run-2 " +
      "WebGL leg drops by between the two altitudes",
  );
});

test("C3: the fade ramps monotonically between the two distances", () => {
  const maximumRadius = 6378137.0;
  const fadeOut = 10_000_000;
  const fadeIn = 20_000_000;
  const at = (dist) =>
    computeLightingFade(
      3,
      { viewMatrix: { 12: 0, 13: 0, 14: -dist }, frustum: {} },
      fadeOut,
      fadeIn,
      maximumRadius,
    );
  assert.equal(at(9_000_000), 0);
  assert.equal(at(15_000_000), 0.5);
  assert.equal(at(21_000_000), 1);
  let previous = -1;
  // Bounded: 21 samples over a fixed span.
  for (let i = 0; i <= 20; i++) {
    const v = at(8_000_000 + i * 750_000);
    assert.ok(v >= previous, "the fade must be non-decreasing in cameraDist");
    previous = v;
  }
});

test("C4: the 2D and Columbus-View arms evaluate GLSL's own selections", () => {
  const maximumRadius = 6378137.0;
  const fadeOut = 10_000_000;
  const fadeIn = 20_000_000;
  // 2D: `max(top - bottom, right - left) * 0.5`, then both distances drop by
  // maxRadii because the mode is not 3D.
  const twoD = computeLightingFade(
    2, // SceneMode.SCENE2D
    {
      viewMatrix: { 12: 0, 13: 0, 14: 0 },
      frustum: {
        offCenterFrustum: {
          top: 4_000_000,
          bottom: -4_000_000,
          left: -9_000_000,
          right: 9_000_000,
        },
      },
    },
    fadeOut,
    fadeIn,
    maximumRadius,
  );
  const expectedDist = Math.max(8_000_000, 18_000_000) * 0.5; // 9 Mm
  const expected2D =
    (expectedDist - (fadeOut - maximumRadius)) /
    (fadeIn - maximumRadius - (fadeOut - maximumRadius));
  assert.equal(twoD, expected2D);
  // The 2D arm must read THROUGH offCenterFrustum: an outer wrapper carrying
  // different planes must be ignored.
  const throughWrapper = computeLightingFade(
    2,
    {
      frustum: {
        top: 1,
        bottom: -1,
        left: -1,
        right: 1,
        offCenterFrustum: {
          top: 4_000_000,
          bottom: -4_000_000,
          left: -9_000_000,
          right: 9_000_000,
        },
      },
    },
    fadeOut,
    fadeIn,
    maximumRadius,
  );
  assert.equal(throughWrapper, expected2D);

  // Columbus View: `-czm_view[3].z`, i.e. element 14 negated. The distance is
  // chosen inside the (radius-reduced) fade band so the arithmetic is visible
  // rather than clamped flat.
  const cv = computeLightingFade(
    1, // SceneMode.COLUMBUS_VIEW
    {
      viewMatrix: { 12: 5_000_000, 13: 12_000_000, 14: -13_000_000 },
      frustum: {},
    },
    fadeOut,
    fadeIn,
    maximumRadius,
  );
  const expectedCV =
    (13_000_000 - (fadeOut - maximumRadius)) /
    (fadeIn - maximumRadius - (fadeOut - maximumRadius));
  assert.ok(
    expectedCV > 0 && expectedCV < 1,
    "the CV sample must not saturate",
  );
  assert.equal(
    cv,
    expectedCV,
    "the CV arm must ignore x/y and take -view[14], like GLSL",
  );
  // Same instant read as 3D would take `length(view[3])`, which includes x/y —
  // a different number. If the two agreed, the mode branch would be untested.
  const asThreeD = computeLightingFade(
    3,
    {
      viewMatrix: { 12: 5_000_000, 13: 12_000_000, 14: -13_000_000 },
      frustum: {},
    },
    fadeOut,
    fadeIn,
    maximumRadius,
  );
  assert.notEqual(asThreeD, cv);
});

test("C5: unavailable inputs degrade to flat-lit, never to a black night side", () => {
  // A returned 0 means `mix(1.0, diffuse, 0) = 1.0` — full brightness. A
  // returned 1 would mean full day/night at ground level, which is the failure
  // this default exists to avoid.
  assert.equal(computeLightingFade(3, undefined, 1e7, 2e7, 6378137), 0);
  assert.equal(computeLightingFade(3, {}, 1e7, 2e7, 6378137), 0);
  assert.equal(computeLightingFade(2, { frustum: {} }, 1e7, 2e7, 6378137), 0);
  assert.equal(
    computeLightingFade(
      3,
      { viewMatrix: { 12: NaN, 13: 0, 14: 0 } },
      1e7,
      2e7,
      6378137,
    ),
    0,
  );
  // Zero span: GLSL would divide by zero and let the clamp resolve the Inf.
  assert.equal(
    computeLightingFade(
      3,
      { viewMatrix: { 12: 0, 13: 0, 14: -1.5e7 } },
      1e7,
      1e7,
      6378137,
    ),
    0,
  );
  // The provider-default fallbacks are the WebGL uniform's own initial value.
  assert.equal(DEFAULT_LIGHTING_FADE_OUT_DISTANCE, 6500000.0);
  assert.equal(DEFAULT_LIGHTING_FADE_IN_DISTANCE, 9000000.0);
  assert.match(
    read("packages/engine/Source/Scene/GlobeSurfaceTileProvider.js"),
    /this\.lightingFadeOutDistance = 6500000\.0;\s*this\.lightingFadeInDistance = 9000000\.0;/,
    "the leaf's fallback defaults drifted from GlobeSurfaceTileProvider's",
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
    `mutation precondition failed: "${from.slice(0, 70)}..." not present`,
  );
  return source.replace(from, to);
}

test("D1: the pre-CO-18 `+ 0.5` alpha ramp is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "return clamp(lambertDiffuse * 5.0, 0.0, 1.0);",
    "return clamp(lambertDiffuse * 5.0 + 0.5, 0.0, 1.0);",
  );
  assert.equal(
    alphaRampsAgree(mutant, glsl),
    false,
    "the grid-equality pin must fail on the offset law",
  );
  // And the disagreement is the recorded 0.5 at the terminator.
  const w = makeRamp(
    coefficients(WGSL_ALPHA_RE.exec(stripLineComments(mutant)), "m"),
  );
  const g = makeRamp(coefficients(GLSL_ALPHA_RE.exec(glslCode), "g"));
  assert.equal(w(0) - g(0), 0.5);
});

test("D2: single-function reuse (lighting driven by the alpha ramp) is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "let dayNightDiffuse = computeDayNightDiffuse(dayNightNormalEC, sunDir);",
    "let dayNightDiffuse = computeDayNightFade(dayNightNormalEC, sunDir);",
  );
  assert.equal(
    consumersAreDistinct(mutant),
    false,
    "two call sites of computeDayNightFade must not pass — that IS the reuse",
  );
});

test("D3: dropping the camera-distance fade is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "diffuse = mix(1.0, dayNightDiffuse, clamp(tile.lightingFade, 0.0, 1.0));",
    "diffuse = dayNightDiffuse;",
  );
  assert.equal(
    lightingAppliesCameraFade(mutant),
    false,
    "an unmixed diffuse must not pass — that is the pre-CO-18 shape lane D " +
      "measured as 0.312 at 3 Mm where WebGL reads 1.000",
  );
});

test("D4: folding the +0.3 night floor into the alpha ramp is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    "return clamp(lambertDiffuse * 5.0, 0.0, 1.0);",
    "return clamp(lambertDiffuse * 5.0 + 0.3, 0.0, 1.0);",
  );
  assert.equal(
    alphaRampsAgree(mutant, glsl),
    false,
    "the `+0.3` belongs to the LIGHTING expression only; leaking it into the " +
      "alpha ramp would leave the night side 30% day-textured",
  );
});

test("D5: a GLSL-SIDE mutation is REJECTED — this spec reads BOTH files", () => {
  // Without this, every assertion above could be satisfied by a WGSL source
  // compared against a stale copy of itself.
  const mutantGlsl = mutate(
    glsl,
    "float nightBlend = 1.0 - clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0, 0.0, 1.0);",
    "float nightBlend = 1.0 - clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 4.0, 0.0, 1.0);",
  );
  assert.equal(alphaRampsAgree(wgsl, mutantGlsl), false);
  const mutantGlslDiffuse = mutate(
    glsl,
    "float diffuseIntensity = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0 + 0.3, 0.0, 1.0);",
    "float diffuseIntensity = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0 + 0.4, 0.0, 1.0);",
  );
  assert.equal(diffuseExpressionsAgree(wgsl, mutantGlslDiffuse), false);
});

test("D6: restoring the pre-CO-18 WGSL diffuse is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    `      let dayNightDiffuse = computeDayNightDiffuse(dayNightNormalEC, sunDir);
      diffuse = mix(1.0, dayNightDiffuse, clamp(tile.lightingFade, 0.0, 1.0));`,
    `      let ambient = 0.12;
      let dayDiffuse = max(dot(dayNightNormalEC, sunDir), 0.0) * 0.88 + ambient;
      let nightAmbient = 0.025;
      diffuse = mix(nightAmbient, dayDiffuse, dayFade);`,
  );
  assert.equal(consumersAreDistinct(mutant), false);
  assert.equal(lightingAppliesCameraFade(mutant), false);
  // The definition-level transcription SURVIVES this mutation — the mutant
  // leaves `computeDayNightDiffuse` intact and simply stops calling it. That is
  // precisely why `diffuseIsConsumed` exists as a separate predicate: without
  // it, an orphaned-but-correct function would satisfy A6.
  assert.equal(
    diffuseExpressionsAgree(mutant, glsl),
    true,
    "precondition: the mutation orphans the function rather than editing it",
  );
  assert.equal(
    diffuseIsConsumed(mutant),
    false,
    "an unconsumed correct function is not a correct shader",
  );
});

// ─── E. the lightingFade uniform slot is plumbed and DISTINCT ────────────────

test("E1: the WGSL struct declares lightingFade where the pad used to be", () => {
  assert.match(
    wgslCode,
    /splitPosition: f32,\s*lightingFade: f32,\s*tileControls: vec4<f32>,/,
    "lightingFade must occupy the scalar slot between splitPosition and " +
      "tileControls — moving it would shift every vec4 after it",
  );
  assert.doesNotMatch(
    wgslCode,
    /_tilePad0/,
    "the old pad name is still present — two names for one slot is drift",
  );
});

test("E2: the CPU offset table agrees with the struct, and nothing else moved", () => {
  assert.match(types, /export const SPLIT_POSITION_OFFSET = 462;/);
  assert.match(types, /export const LIGHTING_FADE_OFFSET = 463;/);
  assert.match(types, /export const TILE_CONTROLS_OFFSET = 464;/);
  assert.match(
    types,
    /export const TILE_UNIFORM_FLOATS = 492;/,
    "the UB grew — a scalar pad was reused, so the size must be unchanged",
  );
});

test("E3: the packer writes the slot from computeLightingFade, ungated", () => {
  assert.match(
    tileUb,
    /data\[LIGHTING_FADE_OFFSET\] = computeLightingFade\(/,
    "the slot must be written from the shared leaf, not re-derived inline",
  );
  // The write must not sit inside the ground-atmosphere gate.
  const write = tileUb.indexOf("data[LIGHTING_FADE_OFFSET]");
  const groundGate = tileUb.indexOf("const showGroundAtmosphere =");
  assert.ok(write > 0 && groundGate > 0);
  assert.ok(
    write < groundGate,
    "lightingFade is written before the ground-atmosphere block and shares " +
      "none of its gating",
  );
});

test("E4: groundAtmosphereControl.y is NOT reused — and here is why it could not be", () => {
  // The tempting shortcut. That slot carries the identical clamp, but it is
  // zeroed whenever the drape is off, which on the lighting path would mean
  // `mix(1.0, diffuse, 0) = 1.0` — a globe with NO day/night lighting at all
  // whenever `globe.showGroundAtmosphere = false`. WebGL applies no such gate.
  assert.match(
    tileUb,
    /let groundAtmosphereFade = 0;\s*if \(showGroundAtmosphere\) \{/,
    "the drape fade is still gated — which is exactly why the lighting fade " +
      "needed its own slot",
  );
  assert.doesNotMatch(
    stripLineComments(wgsl),
    /mix\(1\.0, dayNightDiffuse, [^)]*groundAtmosphereControl/,
    "the lighting arm must not read the drape's gated fade",
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

/** Every flag the shader branches on. Kept in sync by F1. */
const FLAGS = Object.freeze([
  "CAPTURE_MODE",
  "ENHANCED_OCEAN",
  "GEODETIC_NORMAL",
  "GLOBE_IMAGERY_REDUCED",
  "LOG_DEPTH",
  "MATERIAL_APPLY",
]);

/** The lines CO-18 wrote — every define set must be shown to carry them. */
const EDITED_MARKERS = Object.freeze([
  "fn computeDayNightFade(normalEC: vec3<f32>, sunDirEC: vec3<f32>) -> f32 {",
  "fn computeDayNightDiffuse(normalEC: vec3<f32>, sunDirEC: vec3<f32>) -> f32 {",
  "  lightingFade: f32,",
  "let dayNightDiffuse = computeDayNightDiffuse(dayNightNormalEC, sunDir);",
  "diffuse = mix(1.0, dayNightDiffuse, clamp(tile.lightingFade, 0.0, 1.0));",
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
      `${flag} branches the shader but is not in this spec's FLAGS list`,
    );
  }
  assert.equal(used.size, FLAGS.length, `flags in use: ${[...used].join(",")}`);
});

test("F2: every edited line sits at `//>>ifdef` depth 0", () => {
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
    const index = lines.findIndex((l) => l.includes(marker.trim()));
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
        text.includes(marker.trim()),
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
  // `czm_getMaterial`, injected by the material codegen at pipeline-build time
  // and therefore absent from the source module. naga rejects that expansion at
  // HEAD too — a property of the material pipeline, not of this row's edit.
  const validatable = FLAGS.filter((f) => f !== "MATERIAL_APPLY");
  const sets = [[], ...validatable.map((f) => [f]), validatable.slice()];
  for (const defines of sets) {
    const text = expandDefines(wgsl, defines);
    assert.doesNotThrow(
      () => naga.validate_wgsl(text),
      `naga rejected the module under [${defines.join(",") || "none"}]`,
    );
  }
});

test("F5: a shader that still declares the removed helper does NOT validate as reconciled", () => {
  // Negative control on section A's own machinery: if `computeDayNightDiffuse`
  // is deleted, the transcription pins must go false rather than silently
  // skipping. (`coefficients` asserts on a null match, so the predicate's
  // null-guard is what has to catch it.)
  const mutant = wgsl.replace(
    /fn computeDayNightDiffuse\(normalEC: vec3<f32>, sunDirEC: vec3<f32>\) -> f32 \{[\s\S]*?\n\}/,
    "",
  );
  assert.ok(
    !mutant.includes("fn computeDayNightDiffuse("),
    "mutation precondition: the definition was removed",
  );
  assert.equal(diffuseExpressionsAgree(mutant, glsl), false);
});

// ─── G. optional terminator appearance is explicit and backend-neutral ───

function captureTerminatorLaw(source) {
  const body = source.match(
    /(?:fn|vec3) computeTerminatorGlow[\s\S]*?return warmColor \* terminatorFactor \* ([0-9.]+);/,
  );
  assert.ok(body, "terminator-glow function must remain executable");
  const falloff = body[0].match(/NdotL \* NdotL \* ([0-9.]+)/);
  const color = body[0].match(
    /vec3(?:<f32>)?\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)\)/,
  );
  assert.ok(falloff && color, "terminator-glow coefficients must be readable");
  return {
    falloff: Number(falloff[1]),
    color: color.slice(1).map(Number),
    amplitude: Number(body[1]),
  };
}

test("G1: the optional glow defaults to identity and is dynamically mirrored", () => {
  assert.match(globe, /this\.terminatorGlowStrength = 0\.0;/);
  assert.match(
    globe,
    /Number\.isFinite\(terminatorGlowStrength\)[\s\S]*?Math\.max\(terminatorGlowStrength, 0\.0\)/,
  );
  assert.match(
    tileRendering,
    /u_terminatorGlowStrength:[\s\S]*?this\.properties\.terminatorGlowStrength/,
  );
  assert.match(
    tileUb,
    /data\[TILE_CONTROLS_OFFSET \+ 2\] =\s*tileProvider\.terminatorGlowStrength \?\? 0\.0/,
  );
});

test("G2: GLSL and WGSL carry the same glow law", () => {
  const gl = captureTerminatorLaw(glslCode);
  const gpu = captureTerminatorLaw(wgslCode);
  assert.deepEqual(gpu, gl);
  for (const ndotl of [-1, -0.25, 0, 0.25, 1]) {
    const evaluate = (law) =>
      law.color.map(
        (channel) =>
          channel * Math.exp(-ndotl * ndotl * law.falloff) * law.amplitude,
      );
    assert.deepEqual(evaluate(gpu), evaluate(gl));
  }
});

test("G3: zero branches before exp and enabled paths use analytic normal plus absolute eclipse", () => {
  assert.match(
    wgslCode,
    /if \(terminatorGlowStrength > 0\.0\) \{[\s\S]*?computeTerminatorGlow\(dayNightNormalEC, sunDir\)[\s\S]*?terminatorGlowStrength[\s\S]*?eclipseAbsolute/,
  );
  assert.match(
    glslCode,
    /if \(terminatorGlowStrength > 0\.0\)[\s\S]*?czm_geodeticSurfaceNormal\([\s\S]*?computeTerminatorGlow\(terminatorNormalEC, czm_lightDirectionEC\)[\s\S]*?terminatorGlowStrength[\s\S]*?terminatorGlowEclipse/,
  );
  assert.match(glslCode, /terminatorGlowEclipse = eclipseAbsolute;/);
  assert.match(
    glslCode,
    /#if defined\(ENABLE_VERTEX_LIGHTING\) \|\| defined\(ENABLE_DAYNIGHT_SHADING\)/,
  );
});
