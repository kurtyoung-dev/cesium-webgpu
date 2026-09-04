// globe-daynight-alpha-gate.spec.mjs
// @purpose Pins that the imagery day/night alpha is gated on the per-tile alpha condition alone on BOTH backends, with the WebGPU flag derived from the same resolved values as the WebGL define, and mutants for absence and inertness.
// @status ACTIVE
//
// THE BEHAVIOUR, STATED WITHOUT REFERENCE TO ANY IMPLEMENTATION SHAPE.
//
//   An imagery layer that carries a day/night alpha pair asks to be visible on
//   one side of the terminator. Whether the globe is LIT is a different
//   question, asked by a different option. So the day/night alpha must be live
//   exactly when some layer on the tile has a resolved day or night alpha away
//   from 1.0 — and must be inert, at zero cost and with byte-identical output,
//   when no layer does.
//
// Both halves matter and they fail in opposite directions:
//
//   • Tied to lighting, the term vanishes where it is wanted. WebGL emitted
//     `ENABLE_DAYNIGHT_SHADING` only when `globe.enableLighting` was set AND the
//     terrain had no vertex normals, so a `dayAlpha = 0` night layer was
//     invisible at every longitude on the default globe, and invisible again on
//     any terrain that reports vertex normals — which is what the fork's own
//     viewer requests (`Apps/CesiumViewer/CesiumViewer.js` asks for them).
//   • Untied from the alpha condition, the term costs a ramp on every globe
//     that never asked for one, and — on WebGPU, where the shader has no
//     compile-time arms — silently re-shades the night side of a default scene.
//
// WHAT THIS SPEC IS FOR, AND WHAT IT IS NOT.
//
// It reads the two shader sources and the two CPU packs, and it EXECUTES the
// blend arithmetic the shaders perform, so a claim like "the night layer is now
// visible" is checked as a number rather than as a diff. It is deliberately NOT
// a second copy of `globe-daynight-ramp-law.spec.mjs`: that spec owns the ramp
// LAW (the coefficients), this one owns the GATE (when the law runs). The two
// share no assertions, and the ramp-law spec is required here to still pass
// unmodified — section E executes it.
//
// A NOTE ON INDEPENDENCE. Section D mutates by making the change INERT rather
// than merely absent: the flag is packed but always zero, the define is emitted
// but the shader ignores it. A gate that only rejects deletion does not
// distinguish a live branch from a dead one.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read is normalised to
// `\n` first — a spec anchored on a bare `\n` false-greens on a CRLF checkout.
//
// Run: node --test Tools/visual-regression/globe-daynight-alpha-gate.spec.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const wgsl = read(WGSL_PATH);
const glsl = read(GLSL_PATH);
const tileUb = read(TILE_UB_PATH);
const types = read(TYPES_PATH);
const shaderSet = read(SHADER_SET_PATH);
const tileRendering = read(TILE_RENDERING_PATH);

/** Strip line comments so prose can never satisfy a pin. */
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const wgslCode = stripLineComments(wgsl);
const glslCode = stripLineComments(glsl);

// ─── the models, so the claims are arithmetic rather than adjectives ─────────

/**
 * What a fragment's day-side/night-side layer alpha multiplier evaluates to.
 *
 * Both shaders compute `mix(dayAlpha, nightAlpha, nightBlend)` per layer, with
 * `nightBlend = 1 - clamp(N·L * 5, 0, 1)` when the gate is open and a hard 0
 * when it is shut. That second case is the whole subject: a shut gate does not
 * merely skip the ramp, it pins the multiplier at `dayAlpha`.
 */
function layerAlphaMultiplier(ndotl, dayAlpha, nightAlpha, gateOpen) {
  const nightBlend = gateOpen ? 1 - Math.min(1, Math.max(0, ndotl * 5)) : 0;
  return dayAlpha + (nightAlpha - dayAlpha) * nightBlend;
}

/** The per-tile condition both backends derive their gate from. */
function anyLayerAsksForDayNight(layers) {
  return layers.some(
    (layer) => layer.dayAlpha !== 1.0 || layer.nightAlpha !== 1.0,
  );
}

// ─── the two gate literals, in one place ─────────────────────────────────────
//
// The day/night ramp gate is a disjunction, and its terms are independent
// questions. Lighting is the first. The per-tile day/night-alpha flag is the
// second, and it is the one this spec owns. The third, added when the
// procedural night fallback landed, opens the same ramp on exactly the tiles
// the second leaves shut — the fallback runs where there is no night layer —
// and it has its own spec and its own mutants. The pins below moved with that
// widening rather than being weakened by it: every behavioural claim here is
// unchanged, and each literal appears once so the next widening is one line.
const WGSL_GATE =
  "if (camera.enableLighting > 0.5 || tile.tileControls.w > 0.5 || tile.hsbShift.w < 1.0) {";
const WGSL_GATE_RE =
  /if \(camera\.enableLighting > 0\.5 \|\| tile\.tileControls\.w > 0\.5 \|\| tile\.hsbShift\.w < 1\.0\) \{/;
const GLSL_NIGHTBLEND_GUARD =
  "#if defined(APPLY_DAY_NIGHT_ALPHA) || defined(APPLY_NIGHT_DARKNESS)";
const GLSL_NIGHTBLEND_GUARD_RE =
  /#if defined\(APPLY_DAY_NIGHT_ALPHA\) \|\| defined\(APPLY_NIGHT_DARKNESS\)\n\s*float nightBlend = 1\.0 - clamp\(/;

// A night-lights layer as the epic will configure it, and a plain base layer.
const NIGHT_LAYER = Object.freeze({ dayAlpha: 0.0, nightAlpha: 1.0 });
const BASE_LAYER = Object.freeze({ dayAlpha: 1.0, nightAlpha: 1.0 });

// ─── A. the behaviour, executed ──────────────────────────────────────────────

test("A1: a shut gate makes a night-only layer invisible at every N·L", () => {
  // This is the defect, expressed as numbers. With the gate shut the layer's
  // multiplier is `dayAlpha` everywhere, so a dayAlpha = 0 layer contributes
  // nothing on the night side, the day side, or the terminator.
  // Bounded: 41 samples over the full N·L range.
  for (let i = 0; i <= 40; i++) {
    const ndotl = -1 + i * 0.05;
    assert.equal(
      layerAlphaMultiplier(
        ndotl,
        NIGHT_LAYER.dayAlpha,
        NIGHT_LAYER.nightAlpha,
        false,
      ),
      0,
      `a shut gate leaves the night layer at zero alpha at N·L = ${ndotl}`,
    );
  }
});

test("A2: an open gate makes it fully visible past the terminator and absent in daylight", () => {
  const open = (ndotl) =>
    layerAlphaMultiplier(
      ndotl,
      NIGHT_LAYER.dayAlpha,
      NIGHT_LAYER.nightAlpha,
      true,
    );
  assert.equal(open(-0.5), 1, "deep night: the layer is fully opaque");
  assert.equal(
    open(0),
    1,
    "at the geometric terminator it is still full night",
  );
  assert.equal(open(0.2), 0, "the ramp saturates to full day at N·L = 0.2");
  assert.equal(open(1), 0, "subsolar: the night layer is absent");
  // And it is monotone across the dusk band, so the transition cannot band.
  let previous = Infinity;
  for (let i = 0; i <= 20; i++) {
    const v = open(i * 0.01);
    assert.ok(
      v <= previous,
      "the night layer must fade monotonically into day",
    );
    previous = v;
  }
});

test("A3: the gate is inert for a globe whose layers are all at their defaults", () => {
  assert.equal(anyLayerAsksForDayNight([BASE_LAYER, BASE_LAYER]), false);
  // With every layer at (1, 1) the multiplier is 1.0 regardless of the gate, so
  // opening it could not change a pixel even if it were opened wrongly. That is
  // what makes the default path byte-identical rather than merely "close".
  for (let i = 0; i <= 20; i++) {
    const ndotl = -1 + i * 0.1;
    assert.equal(
      layerAlphaMultiplier(ndotl, 1.0, 1.0, true),
      layerAlphaMultiplier(ndotl, 1.0, 1.0, false),
      "an all-default stack must be gate-independent",
    );
  }
});

test("A4: one non-default layer in a stack raises the condition for the whole tile", () => {
  assert.equal(anyLayerAsksForDayNight([BASE_LAYER, NIGHT_LAYER]), true);
  assert.equal(anyLayerAsksForDayNight([NIGHT_LAYER, BASE_LAYER]), true);
  assert.equal(anyLayerAsksForDayNight([]), false);
  // A day-side-only fade counts too: the condition is "away from 1.0" on
  // EITHER member, not "nightAlpha is set".
  assert.equal(
    anyLayerAsksForDayNight([{ dayAlpha: 0.5, nightAlpha: 1.0 }]),
    true,
  );
});

// ─── B. WebGL expresses it with the imagery define ALONE ─────────────────────

test("B1: the nightBlend definition is guarded by APPLY_DAY_NIGHT_ALPHA only", () => {
  assert.match(
    glslCode,
    GLSL_NIGHTBLEND_GUARD_RE,
    "conjoining a lighting define here is what pinned nightBlend at 0 on the " +
      "default globe and on vertex-normal terrain",
  );
  assert.doesNotMatch(
    glslCode,
    /#if defined\(APPLY_DAY_NIGHT_ALPHA\) && defined\(ENABLE_DAYNIGHT_SHADING\)/,
    "neither of the alpha's two sites may re-acquire the lighting conjunction",
  );
});

test("B2: the sampleAndBlend multiply is guarded the same way", () => {
  // Both sites must move together: guarding the definition alone would leave a
  // correctly-computed nightBlend that no layer ever consumes.
  //
  // Structural rather than adjacent: the night alpha the blend reads is scaled
  // by the fragment's own magnification first, so statements sit between the
  // guard and the blend. What this spec owns is that the blend is inside the
  // block, which the excluded preprocessor directive is what pins.
  assert.match(
    glslCode,
    /#ifdef APPLY_DAY_NIGHT_ALPHA[^#]*?textureAlpha \*= mix\(textureDayAlpha, effectiveNightAlpha, nightBlend\);/,
  );
});

test("B3: the analytic normal is declared wherever the alpha is guarded", () => {
  // Not stylistic: `normalEC` used to be declared only under the ocean /
  // daynight-shading / HDR union. Widening the alpha's guard without widening
  // this one leaves the blend referencing an undeclared identifier, and the
  // program fails to compile on exactly the configurations the change targets.
  const declaration =
    /#if (defined\([A-Z_]+\)(?: \|\| )?)+\n\s*vec3 normalMC = czm_geodeticSurfaceNormal\(v_positionMC, vec3\(0\.0\), vec3\(1\.0\)\);/.exec(
      glslCode,
    );
  assert.ok(declaration, "the analytic normal declaration was not found");
  assert.match(
    declaration[0],
    /defined\(APPLY_DAY_NIGHT_ALPHA\)/,
    "APPLY_DAY_NIGHT_ALPHA must be one of the alternatives that declares it",
  );
  // And the blend really does read that identifier rather than a mesh varying.
  assert.match(
    glslCode,
    /float nightBlend = 1\.0 - clamp\(czm_getLambertDiffuse\(czm_lightDirectionEC, normalEC\) \*/,
  );
  assert.doesNotMatch(
    glslCode,
    /float nightBlend = 1\.0 - clamp\(czm_getLambertDiffuse\(czm_lightDirectionEC, v_normalEC\)/,
    "the mesh varying is not written on the day/night path at all",
  );
});

test("B4: the define is still derived from the per-layer alphas, unchanged", () => {
  // The condition itself is upstream's and must not have moved: this row
  // widened where the define is CONSUMED, not when it is RAISED.
  assert.match(
    shaderSet,
    /if \(applyDayNightAlpha\) \{\s*fs\.defines\.push\("APPLY_DAY_NIGHT_ALPHA"\);\s*\}/,
  );
  assert.match(
    tileRendering,
    /applyDayNightAlpha =\s*applyDayNightAlpha \|\|\s*uniformMapProperties\.dayTextureNightAlpha\[numberOfDayTextures\] !== 1\.0;/,
  );
  assert.match(
    tileRendering,
    /applyDayNightAlpha =\s*applyDayNightAlpha \|\|\s*uniformMapProperties\.dayTextureDayAlpha\[numberOfDayTextures\] !== 1\.0;/,
  );
  // Both derivations read back the WRITTEN array slot, which is what makes the
  // condition agree with the value the shader will actually blend.
});

test("B5: the lighting arms themselves are untouched", () => {
  // The vertex-lighting / daynight-shading split is upstream's and still
  // governs the DIFFUSE. Only the imagery alpha was lifted out of it; if this
  // pin ever fails, the change grew beyond its subject.
  assert.match(
    shaderSet,
    /if \(enableLighting\) \{\s*if \(hasVertexNormals\) \{[\s\S]{0,240}?ENABLE_VERTEX_LIGHTING[\s\S]{0,240}?\} else \{[\s\S]{0,240}?ENABLE_DAYNIGHT_SHADING/,
  );
  assert.match(
    glslCode,
    /#ifdef ENABLE_VERTEX_LIGHTING\n\s*float diffuseIntensity = clamp\(czm_getLambertDiffuse\(czm_lightDirectionEC, normalize\(v_normalEC\)\)/,
    "the vertex-lighting diffuse still reads the MESH normal, as it should",
  );
});

// ─── C. WebGPU expresses it with a runtime flag on the same condition ────────

test("C1: the WGSL gate opens on lighting OR the per-tile alpha flag", () => {
  assert.match(
    wgslCode,
    /if \(camera\.enableLighting > 0\.5 \|\| tile\.tileControls\.w > 0\.5 \|\| tile\.hsbShift\.w < 1\.0\) \{\n\s*dayFade = computeDayNightFade\(dayNightNormalEC, sunDir\);\n\s*nightBlend = 1\.0 - dayFade;\n\s*\} else \{\n\s*dayFade = 1\.0;\n\s*nightBlend = 0\.0;\n\s*\}/,
    "the shut arm must still pin dayFade at 1.0 — that is the byte-identity " +
      "guarantee for a globe with neither lighting, a day/night layer, nor " +
      "the procedural fallback",
  );
});

test("C2: the flag occupies the reserved slot, and nothing after it moved", () => {
  // `tileControls.w` was a declared reserved scalar. Reusing it keeps every
  // offset after it fixed; a member inserted here would shift the whole tail.
  //
  // The guarantee is about the offsets that FOLLOW the reused slot, so assert
  // those directly. The buffer total is a poor proxy for it: a later member
  // appended past the end of the struct grows the total while shifting
  // nothing, which is a legal change this test should not fail.
  assert.match(types, /export const TILE_CONTROLS_OFFSET = 464;/);
  assert.match(
    types,
    /export const HSB_SHIFT_OFFSET = 468;/,
    "a reserved slot was reused, so the member after it must not have moved",
  );
  assert.match(
    types,
    /export const OCEAN_WAVE_PHASE_B_OFFSET = 488;/,
    "nor may the last member of the pre-existing tail have moved",
  );
  assert.match(
    wgslCode,
    /lightingFade: f32,\n\s*tileControls: vec4<f32>,/,
    "the struct layout around the reused slot must be unchanged",
  );
  assert.doesNotMatch(
    tileUb,
    /data\[TILE_CONTROLS_OFFSET \+ 3\] = 0;/,
    "the slot must no longer be hard-zeroed",
  );
});

test("C3: the flag is derived from the RESOLVED per-layer alphas, in the pack loop", () => {
  // The two backends must agree tile for tile, so the WebGPU condition has to
  // read the same numbers WebGL's define does — the resolved values, after a
  // Function-valued alpha has been called, not the raw properties.
  assert.match(
    tileUb,
    /if \(data\[dnFloatBase \+ 0\] !== 1\.0 \|\| data\[dnFloatBase \+ 1\] !== 1\.0\) \{\s*dayNightAlphaActive = true;\s*\}/,
    "reading back the written slots is what makes the condition agree with " +
      "the value the shader blends",
  );
  assert.match(
    tileUb,
    /data\[TILE_CONTROLS_OFFSET \+ 3\] = dayNightAlphaActive \? 1\.0 : 0\.0;/,
  );
  // The accumulator must be reset per tile, not per frame: a stale true would
  // leave the ramp on for tiles that carry no day/night layer.
  const declaration = tileUb.indexOf("let dayNightAlphaActive = false;");
  const loop = tileUb.indexOf("let layerCount = 0;");
  assert.ok(declaration > 0 && loop > 0);
  assert.ok(
    Math.abs(declaration - loop) < 500,
    "the accumulator must be declared beside the per-tile layer count, inside " +
      "the same per-tile pack",
  );
});

test("C4: the write is unconditional — no gate of its own", () => {
  // A flag written only under some other condition would reintroduce exactly
  // the coupling this row removed, one level up.
  const write = tileUb.indexOf("data[TILE_CONTROLS_OFFSET + 3] =");
  assert.ok(write > 0);
  const preceding = tileUb.slice(Math.max(0, write - 400), write);
  assert.doesNotMatch(
    preceding,
    /if \([^)]*enableLighting[^)]*\) \{/,
    "the flag must not be packed inside a lighting branch",
  );
});

// ─── D. MUTANTS — absence and inertness, on each backend ─────────────────────

/** All mutation is IN MEMORY. No file is written, so a throw leaves no mess. */
function mutate(source, from, to) {
  assert.ok(
    source.includes(from),
    `mutation precondition failed: "${from.slice(0, 70)}..." not present`,
  );
  return source.replace(from, to);
}

/** The predicates under test, as functions of a source so mutants can run them. */
function webgpuGateIsWidened(wgslSource) {
  return WGSL_GATE_RE.test(stripLineComments(wgslSource));
}
function webgpuFlagIsLive(tileUbSource) {
  return (
    /data\[TILE_CONTROLS_OFFSET \+ 3\] = dayNightAlphaActive \? 1\.0 : 0\.0;/.test(
      tileUbSource,
    ) &&
    /if \(data\[dnFloatBase \+ 0\] !== 1\.0 \|\| data\[dnFloatBase \+ 1\] !== 1\.0\) \{\s*dayNightAlphaActive = true;\s*\}/.test(
      tileUbSource,
    )
  );
}
function webglAlphaIsUngated(glslSource) {
  const code = stripLineComments(glslSource);
  return (
    GLSL_NIGHTBLEND_GUARD_RE.test(code) &&
    /#ifdef APPLY_DAY_NIGHT_ALPHA[^#]*?textureAlpha \*= mix\(/.test(code) &&
    !/#if defined\(APPLY_DAY_NIGHT_ALPHA\) && defined\(ENABLE_DAYNIGHT_SHADING\)/.test(
      code,
    )
  );
}

test("D1: ABSENCE — the pristine WGSL gate is REJECTED", () => {
  const mutant = mutate(wgsl, WGSL_GATE, "if (camera.enableLighting > 0.5) {");
  assert.equal(webgpuGateIsWidened(mutant), false);
});

test("D2: INERTNESS — a flag that is packed but never true is REJECTED", () => {
  // The failure mode a deletion mutant cannot see: every symbol present, the
  // slot written, the gate reading it — and the condition that would raise it
  // made unreachable, so the night layer stays invisible on WebGPU.
  const mutant = mutate(
    tileUb,
    "if (data[dnFloatBase + 0] !== 1.0 || data[dnFloatBase + 1] !== 1.0) {",
    "if (false && (data[dnFloatBase + 0] !== 1.0 || data[dnFloatBase + 1] !== 1.0)) {",
  );
  assert.equal(
    webgpuFlagIsLive(mutant),
    false,
    "an unreachable raise must not pass — the slot would be a constant zero",
  );
});

test("D3: INERTNESS — a gate that reads the flag and discards it is REJECTED", () => {
  const mutant = mutate(
    wgsl,
    WGSL_GATE,
    "if (camera.enableLighting > 0.5 || (tile.tileControls.w > 0.5 && false) || tile.hsbShift.w < 1.0) {",
  );
  assert.equal(webgpuGateIsWidened(mutant), false);
});

test("D4: ABSENCE — restoring either GLSL double guard is REJECTED", () => {
  const atDefinition = mutate(
    glsl,
    `${GLSL_NIGHTBLEND_GUARD}\n    float nightBlend = 1.0 - clamp(`,
    "#if defined(APPLY_DAY_NIGHT_ALPHA) && defined(ENABLE_DAYNIGHT_SHADING)\n    float nightBlend = 1.0 - clamp(",
  );
  assert.equal(webglAlphaIsUngated(atDefinition), false);
  const atMultiply = mutate(
    glsl,
    "#ifdef APPLY_DAY_NIGHT_ALPHA\n    // A night layer retires with magnification",
    "#if defined(APPLY_DAY_NIGHT_ALPHA) && defined(ENABLE_DAYNIGHT_SHADING)\n    // A night layer retires with magnification",
  );
  assert.equal(
    webglAlphaIsUngated(atMultiply),
    false,
    "guarding the definition alone leaves a nightBlend nothing consumes",
  );
});

test("D5: the mutants are DISCRIMINATING — the real sources pass every predicate", () => {
  // Without this, a predicate that is false for everything would look like a
  // perfect mutant killer.
  assert.equal(webgpuGateIsWidened(wgsl), true);
  assert.equal(webgpuFlagIsLive(tileUb), true);
  assert.equal(webglAlphaIsUngated(glsl), true);
});

test("D6: the WebGL guard must be dropped on BOTH backends or neither", () => {
  // The cross-backend pin. A packet that widened only WebGL would leave WebGPU
  // pinned at dayFade = 1.0 on an unlit globe, so the same scene would show the
  // night layer on one backend and not the other.
  const glslOnly =
    webglAlphaIsUngated(glsl) &&
    !webgpuGateIsWidened(
      mutate(wgsl, WGSL_GATE, "if (camera.enableLighting > 0.5) {"),
    );
  assert.equal(
    glslOnly,
    true,
    "precondition: this constructs the one-sided packet",
  );
  // The pair of predicates is what rejects it; neither alone would.
  assert.equal(
    webglAlphaIsUngated(glsl) &&
      webgpuGateIsWidened(
        mutate(wgsl, WGSL_GATE, "if (camera.enableLighting > 0.5) {"),
      ),
    false,
  );
});

// ─── E. the ramp law itself is untouched ─────────────────────────────────────

test("E1: the ramp-contract spec still passes, unmodified", () => {
  // This row changed WHEN the ramp runs. If it also changed WHAT it computes,
  // that is a different row and a different contract. Running the other spec is
  // the only check that survives a careless edit to a coefficient here.
  // The child must not inherit this runner's test context, or node routes
  // its report away from stdout and the reading below sees an empty string.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", "Tools/visual-regression/globe-daynight-ramp-law.spec.mjs"],
    { cwd: root, encoding: "utf8", env: childEnv },
  );
  const report = result.stdout ?? "";
  assert.equal(
    result.status,
    0,
    `globe-daynight-ramp-law.spec.mjs is red:\n${report}`,
  );
  assert.match(
    report,
    /# fail 0/,
    "the child produced no readable report, so its green is unverified",
  );
});

test("E2: the two backends' ramp expressions are still character-identical in law", () => {
  // A cheap independent read of the same fact, so E1's failure mode (the spec
  // file itself being edited away) is visible here too.
  assert.match(
    glslCode,
    /clamp\(czm_getLambertDiffuse\(czm_lightDirectionEC, normalEC\) \* 5\.0, 0\.0, 1\.0\)/,
  );
  assert.match(wgslCode, /return clamp\(lambertDiffuse \* 5\.0, 0\.0, 1\.0\);/);
});
