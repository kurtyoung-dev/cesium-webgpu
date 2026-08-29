// globe-night-lights-emission.spec.mjs
// @purpose Pins city-light emission as ONE law on two shaders: the same gate, the same luminance, the same product and the same unset sentinel on both backends, reachable at the shipped defaults, and inert for a layer that is not a night layer.
// @status ACTIVE
//
// THE BEHAVIOUR, STATED WITHOUT REFERENCE TO ANY IMPLEMENTATION SHAPE.
//
//   Imagery that shows a city at night is a picture of light, not of a surface
//   the sun will later light. Composited like ordinary imagery it reads as grey
//   pavement. So a layer that is MORE opaque past the terminator than before it
//   is treated as emissive: its own colour is added back on top of the
//   composite, in proportion to its luminance, so that bright cores glow and
//   dark countryside does not.
//
//   Four properties carry it, and each fails differently:
//
//   • IT IS ONE LAW ON TWO BACKENDS. The globe renders on WebGL or on WebGPU
//     and must look the same either way. Two shading languages cannot share a
//     function, so the two are held together by being executed against each
//     other rather than by being read side by side. A divergence here is not a
//     bug in one backend; it is the feature meaning two different things.
//   • THE GATE IS THE ALPHA PAIR, NOT THE LAYER. An ordinary layer covers day
//     and night alike and contributes nothing. The discriminator is a night
//     alpha that EXCEEDS the day alpha by more than a hair, which is what keeps
//     a pair that happens to be equal from glowing.
//   • ZERO IS A VALUE. The intensity slot carries a magnitude, and zero is a
//     documented request for no emission. "Nothing was configured" therefore
//     cannot be spelled zero, on either backend, or the off state and the
//     default state become the same number.
//   • IT IS REACHED. The feature ships ON, so a globe that asked for nothing
//     must actually compile and run the term on both backends. A gate that can
//     never open is indistinguishable from a feature that was never written.
//
// WHAT THIS SPEC IS FOR. It EXECUTES the emission law, with every constant read
// out of the two shader sources rather than restated here, so "the two backends
// agree" is checked as a number. It also executes the two CPU resolvers by
// running their own shipped text, so the value each backend hands its shader is
// the artifact's, not this file's. It owns neither the dusk ramp
// (globe-daynight-ramp-law), the gate that arms the ramp
// (globe-daynight-alpha-gate), the procedural darkening the emission sits on
// top of (globe-night-darkness-fallback), nor the sentinel's own history
// (globe-night-ocean-sentinel).
//
// LINE ENDINGS: this repo checks out CRLF. Every source read is normalised to a
// bare newline first — a spec anchored on one false-greens on a CRLF checkout.
//
// Run: node --test Tools/visual-regression/globe-night-lights-emission.spec.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const WGSL_PATH =
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const GLSL_PATH = "packages/engine/Source/Shaders/GlobeFS.glsl";
const SHADER_SET_PATH = "packages/engine/Source/Scene/GlobeSurfaceShaderSet.js";
const TILE_RENDERING_PATH =
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js";
const TILE_UB_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts";
const TUNABLES_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeTunables.ts";
const GLOBE_PATH = "packages/engine/Source/Scene/Globe.js";

function absolute(relativePath) {
  return path.join(root, relativePath);
}

function read(relativePath) {
  return fs.readFileSync(absolute(relativePath), "utf8").replace(/\r\n/g, "\n");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
/**
 * The two line endings, spelled from character codes.
 *
 * The mutants below read source files back off disk, and this tree is CRLF. A
 * needle written with bare newlines cannot match a CRLF file, so a mutant that
 * missed its target would report a green it never earned.
 */
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

/** Strip line comments so prose can never satisfy a pin. */
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

// ─── the law, read OUT of the two sources rather than restated ───────────────

/**
 * The emission law of one backend, assembled from constants parsed out of that
 * backend's own shader.
 *
 * Nothing below is written twice. Each field is captured from the source, and a
 * capture that fails throws rather than falling back to a plausible default —
 * an extraction that silently substitutes this file's idea of the law would
 * certify this file.
 */
function emissionLawFrom(source, patterns) {
  const code = stripLineComments(source);

  const gate = code.match(patterns.gate);
  assert.ok(gate, `${patterns.name}: no night-layer gate found`);
  const epsilon = Number(gate[1]);
  assert.ok(Number.isFinite(epsilon), `${patterns.name}: gate epsilon`);

  const weights = code.match(patterns.weights);
  assert.ok(weights, `${patterns.name}: no luminance weights found`);
  const rgb = [1, 2, 3].map((group) => Number(weights[group]));
  for (const weight of rgb) {
    assert.ok(Number.isFinite(weight), `${patterns.name}: luminance weight`);
  }

  const sentinel = code.match(patterns.sentinel);
  assert.ok(sentinel, `${patterns.name}: no unset sentinel found`);
  const fallback = Number(sentinel[1]);
  assert.ok(Number.isFinite(fallback), `${patterns.name}: unset fallback`);

  const product = code.match(patterns.product);
  assert.ok(product, `${patterns.name}: no emission product found`);
  const factors = product[1]
    .split("*")
    .map((factor) => factor.trim())
    .map((factor) => factor.replace(/\(\)$/, ""));

  const combine = code.match(patterns.combine);
  assert.ok(combine, `${patterns.name}: emission is not added to the color`);

  return {
    name: patterns.name,
    epsilon,
    rgb,
    fallback,
    factors,
    /**
     * The shipped law as a function. `packedIntensity` is the number the CPU
     * wrote into the slot, so the sentinel arm is part of what is executed.
     */
    emission(layerColor, nightBlend, nightAlpha, dayAlpha, packedIntensity) {
      const isNightLayer = dayAlpha + epsilon <= nightAlpha ? 1 : 0;
      const lum =
        layerColor[0] * rgb[0] +
        layerColor[1] * rgb[1] +
        layerColor[2] * rgb[2];
      const intensity = packedIntensity < 0 ? fallback : packedIntensity;
      const scale = lum * nightBlend * intensity * isNightLayer;
      return [
        layerColor[0] * scale,
        layerColor[1] * scale,
        layerColor[2] * scale,
      ];
    },
  };
}

const wgsl = read(WGSL_PATH);
const glsl = read(GLSL_PATH);
const shaderSet = read(SHADER_SET_PATH);
const tileRendering = read(TILE_RENDERING_PATH);
const tileUb = read(TILE_UB_PATH);
const tunables = read(TUNABLES_PATH);
const globe = read(GLOBE_PATH);

const WGSL_PATTERNS = {
  name: "WGSL",
  gate: /let isNightLayer = step\(dayAlpha \+ ([\d.]+), nightAlpha\);/,
  weights:
    /fn luminance\(color: vec3<f32>\) -> f32 \{\s*return dot\(color, vec3<f32>\(([\d.]+), ([\d.]+), ([\d.]+)\)\);\s*\}/,
  sentinel:
    /fn getNightIntensity\(\) -> f32 \{\s*let n = tile\.nightOceanParams\.x;\s*return select\(n, ([\d.]+), n < 0\.0\);\s*\}/,
  product: /let emission = ([^;]+);/,
  combine: /return color \+ emission;/,
};

const GLSL_PATTERNS = {
  name: "GLSL",
  gate: /float isNightLayer = step\(dayAlpha \+ ([\d.]+), nightAlpha\);/,
  weights:
    /float lum = dot\(layerColor, vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)\);/,
  sentinel:
    /float nightLightsIntensity\(\)\s*\{\s*return u_nightIntensity < 0\.0 \? ([\d.]+) : u_nightIntensity;\s*\}/,
  product: /vec3 emission = ([^;]+);/,
  combine: /return color \+ emission;/,
};

/** A deterministic sweep of the law's whole input space. */
const CASES = [];
for (const layerColor of [
  [0, 0, 0],
  [1, 1, 1],
  [0.9, 0.85, 0.6],
  [0.05, 0.05, 0.08],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.5, 0.25, 0.125],
]) {
  for (const nightBlend of [0, 0.001, 0.25, 0.5, 0.75, 1]) {
    for (const [dayAlpha, nightAlpha] of [
      [0, 1],
      [1, 1],
      [0, 0],
      [0.5, 0.5],
      [0.5, 0.505],
      [0.5, 0.52],
      [1, 0],
      [0.25, 0.75],
    ]) {
      for (const packedIntensity of [-1, 0, 0.5, 2.5, 7]) {
        CASES.push([
          layerColor,
          nightBlend,
          nightAlpha,
          dayAlpha,
          packedIntensity,
        ]);
      }
    }
  }
}

function maximumDivergence(a, b) {
  let worst = 0;
  for (const [color, blend, nightAlpha, dayAlpha, packed] of CASES) {
    const left = a.emission(color, blend, nightAlpha, dayAlpha, packed);
    const right = b.emission(color, blend, nightAlpha, dayAlpha, packed);
    for (let channel = 0; channel < 3; channel++) {
      worst = Math.max(worst, Math.abs(left[channel] - right[channel]));
    }
  }
  return worst;
}

// ─── A. one law, two shaders ─────────────────────────────────────────────────

test("A1: both shaders carry an emission law this spec can read out", () => {
  const wgslLaw = emissionLawFrom(wgsl, WGSL_PATTERNS);
  const glslLaw = emissionLawFrom(glsl, GLSL_PATTERNS);
  // Anti-vacuity: an extraction that captured nothing would make every
  // comparison below trivially true, so the captured values are asserted to be
  // the kind of numbers the law needs before they are used.
  for (const law of [wgslLaw, glslLaw]) {
    assert.ok(law.epsilon > 0, `${law.name}: the gate must have a real margin`);
    assert.ok(
      law.rgb.reduce((sum, weight) => sum + weight, 0) > 0.99,
      `${law.name}: luminance weights must sum to about one`,
    );
    assert.ok(law.fallback > 0, `${law.name}: the unset fallback must emit`);
    assert.ok(
      law.factors.length >= 4,
      `${law.name}: the product must carry colour, luminance, ramp and gate`,
    );
  }
});

test("A2: the two laws are numerically the SAME law, not merely similar", () => {
  const wgslLaw = emissionLawFrom(wgsl, WGSL_PATTERNS);
  const glslLaw = emissionLawFrom(glsl, GLSL_PATTERNS);
  assert.equal(
    maximumDivergence(wgslLaw, glslLaw),
    0,
    "the two backends must emit bit-identical values over the whole sweep",
  );
  // The constants, separately, so a failure says WHICH constant moved.
  assert.equal(wgslLaw.epsilon, glslLaw.epsilon, "gate margin");
  assert.deepEqual(wgslLaw.rgb, glslLaw.rgb, "luminance weights");
  assert.equal(wgslLaw.fallback, glslLaw.fallback, "unset fallback");
});

test("A3: the product multiplies the same five things on both backends", () => {
  // Order is not the claim — multiplication commutes — but membership is: a
  // backend that dropped the ramp, or the gate, or its own luminance would
  // still produce a plausible picture and a wrong one.
  const wgslLaw = emissionLawFrom(wgsl, WGSL_PATTERNS);
  const glslLaw = emissionLawFrom(glsl, GLSL_PATTERNS);
  const shape = (law) => [...law.factors].sort();
  assert.deepEqual(shape(wgslLaw), shape(glslLaw));
  assert.deepEqual(shape(wgslLaw), [
    "isNightLayer",
    "layerColor",
    "lum",
    "nightBlend",
    "nightIntensity",
  ]);
});

// ─── B. the gate is the alpha pair ───────────────────────────────────────────

test("B1: an ordinary layer contributes exactly nothing", () => {
  const law = emissionLawFrom(glsl, GLSL_PATTERNS);
  // The pair every layer that never asked for day/night alpha resolves to, and
  // the pair the generated WebGL call sites fall back to when the day/night
  // define is absent. Both must be silent.
  for (const [dayAlpha, nightAlpha] of [
    [1, 1],
    [0, 0],
    [0.5, 0.5],
    [1, 0],
  ]) {
    assert.deepEqual(
      law.emission([1, 1, 1], 1, nightAlpha, dayAlpha, 2.5),
      [0, 0, 0],
      `a layer at (${dayAlpha}, ${nightAlpha}) must not glow`,
    );
  }
});

test("B2: the fork's own night layer opens the gate, at full night only", () => {
  const law = emissionLawFrom(glsl, GLSL_PATTERNS);
  // The bundled night layer's ratified alpha pair.
  const dayAlpha = 0.0;
  const nightAlpha = 1.0;
  const day = law.emission([0.9, 0.85, 0.6], 0, nightAlpha, dayAlpha, 2.5);
  const night = law.emission([0.9, 0.85, 0.6], 1, nightAlpha, dayAlpha, 2.5);
  assert.deepEqual(day, [0, 0, 0], "nothing glows in daylight");
  assert.ok(night[0] > 0, "and the night side does");
  // Monotone into night, so there is no step at the terminator.
  let previous = -1;
  for (const blend of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const value = law.emission(
      [0.9, 0.85, 0.6],
      blend,
      nightAlpha,
      dayAlpha,
      2.5,
    )[0];
    assert.ok(value >= previous, "emission must rise monotonically into night");
    previous = value;
  }
});

test("B3: luminance is what makes a city core brighter than its outskirts", () => {
  const law = emissionLawFrom(glsl, GLSL_PATTERNS);
  const core = law.emission([0.9, 0.9, 0.8], 1, 1, 0, 2.5)[0];
  const outskirt = law.emission([0.2, 0.2, 0.18], 1, 1, 0, 2.5)[0];
  assert.ok(core > outskirt, "a brighter texel must glow more");
  // Superlinear, because the colour is scaled by its own luminance: the ratio
  // of emissions must exceed the ratio of the colours that produced them.
  assert.ok(
    core / outskirt > 0.9 / 0.2,
    "the boost must be luminance-weighted",
  );
  assert.deepEqual(
    law.emission([0, 0, 0], 1, 1, 0, 2.5),
    [0, 0, 0],
    "unlit ground emits nothing",
  );
});

// ─── C. zero is a value, on both CPU halves ──────────────────────────────────

/**
 * The WebGPU resolver, executed as its own shipped text.
 *
 * The function is lifted out of the TypeScript module and its annotations
 * removed; nothing about its body is retyped here, so a change to the shipped
 * arithmetic changes what this test runs.
 */
function webgpuResolver() {
  const match = tunables.match(
    /export function resolveGlobeTunable\([^)]*\): number \{([\s\S]*?)\n\}/,
  );
  assert.ok(match, "the WebGPU resolver must still be a named export");
  // The body closes over the module's own marker, so it is supplied as a free
  // name rather than substituted: the number comes from the module too.
  // eslint-disable-next-line no-new-func
  const body = new Function(
    "GLOBE_UB_UNSET",
    "enabled",
    "value",
    "offValue",
    match[1],
  );
  return (enabled, value, offValue) =>
    body(unsetMarker().wgpu, enabled, value, offValue);
}

/**
 * The WebGL resolver, executed as its own shipped text.
 *
 * Same treatment: the block that computes the packed intensity is lifted whole
 * out of `GlobeSurfaceTileProviderRendering.js` and run, with `tileProvider`
 * and the sentinel supplied as the only free names.
 */
function webglResolver() {
  const match = tileRendering.match(
    /(const nightLightsOn = [\s\S]*?: NIGHT_LIGHTS_UNSET;)/,
  );
  assert.ok(match, "the WebGL resolver block must still be findable");
  // eslint-disable-next-line no-new-func
  return new Function(
    "tileProvider",
    "NIGHT_LIGHTS_UNSET",
    `${match[1]}\nreturn nightIntensity;`,
  );
}

function unsetMarker() {
  const wgpu = tunables.match(/export const GLOBE_UB_UNSET = (-?[\d.]+);/);
  const webgl = tileRendering.match(/const NIGHT_LIGHTS_UNSET = (-?[\d.]+);/);
  assert.ok(wgpu && webgl, "both backends must name their unset marker");
  return { wgpu: Number(wgpu[1]), webgl: Number(webgl[1]) };
}

test("C1: both backends mark 'unset' with the same unreachable number", () => {
  const marker = unsetMarker();
  assert.equal(marker.wgpu, marker.webgl);
  assert.ok(
    marker.wgpu < 0,
    "the marker must sit off the API's non-negative domain",
  );
  // ...and the shaders must agree that this is the arm it selects.
  assert.equal(emissionLawFrom(wgsl, WGSL_PATTERNS).fallback, 2.5);
  assert.equal(emissionLawFrom(glsl, GLSL_PATTERNS).fallback, 2.5);
});

test("C2: the two CPU resolvers pack the same float for every reachable state", () => {
  const webgpu = webgpuResolver();
  const webgl = webglResolver();
  const marker = unsetMarker();
  // The off value the WebGPU night-lights call site supplies, read from the
  // call rather than assumed: for this tunable "off" means zero emission.
  const offValue = tileUb.match(
    /data\[NIGHT_OCEAN_PARAMS_OFFSET \+ 0\] = resolveGlobeTunable\(\s*nightLightsOn,\s*tileProvider\?\.nightIntensity,\s*([\d.]+),\s*\);/,
  );
  assert.ok(
    offValue,
    "the WebGPU night-lights call must still supply its off value",
  );
  const off = Number(offValue[1]);
  assert.equal(off, 0, "off means zero emission for this tunable");

  const states = [];
  for (const enableNightLights of [true, false, undefined]) {
    for (const nightIntensity of [
      2.5,
      0,
      0.001,
      10,
      -3,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      null,
      "2.5",
    ]) {
      states.push({ enableNightLights, nightIntensity });
    }
  }
  for (const provider of states) {
    const enabled = provider.enableNightLights !== false;
    assert.equal(
      webgl(provider, marker.webgl),
      webgpu(enabled, provider.nightIntensity, off),
      `the two packers disagree for ${JSON.stringify(provider)}`,
    );
  }
});

test("C3: off and default-on are different numbers, and zero survives", () => {
  const webgl = webglResolver();
  const marker = unsetMarker();
  const law = emissionLawFrom(glsl, GLSL_PATTERNS);
  const rendered = (provider) =>
    law.emission([1, 1, 1], 1, 1, 0, webgl(provider, marker.webgl))[0];

  const on = rendered({ enableNightLights: true, nightIntensity: 2.5 });
  const off = rendered({ enableNightLights: false, nightIntensity: 2.5 });
  assert.ok(on > 0, "default-on must glow");
  assert.equal(off, 0, "off must be reachable, and must be silence");
  // The collision this sentinel exists to prevent: a zero on the ENABLED path
  // is the application's own request and must not resolve to the default.
  assert.equal(
    rendered({ enableNightLights: true, nightIntensity: 0 }),
    0,
    "an explicit zero intensity must not alias onto the default",
  );
  // ...while an absent value on the enabled path is the one case the shader's
  // own default is for.
  assert.equal(
    rendered({ enableNightLights: true, nightIntensity: undefined }),
    on,
    "an unpopulated mirror must render as the shipped default",
  );
});

// ─── D. it is reached, at the shipped defaults, on both backends ─────────────

test("D1: the feature ships ON, with one assignment and matching JSDoc", () => {
  assert.match(globe, /this\.enableNightLights = true;/);
  assert.doesNotMatch(globe, /this\.enableNightLights = false;/);
  assert.equal(
    globe.match(/this\.enableNightLights =/g)?.length ?? 0,
    1,
    "Globe.enableNightLights must have exactly one assignment",
  );
  const index = globe.search(/this\.enableNightLights = true;/);
  const jsdocStart = globe.lastIndexOf("/**", index);
  const jsdocEnd = globe.indexOf("*/", jsdocStart);
  const jsdoc = globe.slice(jsdocStart, jsdocEnd + 2);
  assert.match(jsdoc, /^\s*\*\s*@default true\s*$/m);
  assert.doesNotMatch(jsdoc, /^\s*\*\s*@default false\s*$/m);
  // The WebGPU-only wording was the contract before this row and is now false
  // on its face; a doc that still says it would send applications looking for a
  // WebGL gap that is not there.
  assert.doesNotMatch(
    jsdoc,
    /only on the WebGPU|WebGL path ignores/i,
    "the amended contract is both backends",
  );
});

test("D2: WebGL compiles the term for a globe that asked for nothing", () => {
  // The three links in the WebGL chain, each of which alone would make the
  // feature unreachable while leaving every symbol present.
  assert.match(
    tileRendering,
    /surfaceShaderSetOptions\.applyNightLights =\s*nightLightsOn && applyDayNightAlpha;/,
    "the option must be derived from the enable and the alpha pair",
  );
  assert.match(
    shaderSet,
    /if \(applyNightLights\) \{\s*fs\.defines\.push\("APPLY_NIGHT_LIGHTS"\);\s*\}/,
    "the option must raise the define",
  );
  assert.match(
    shaderSet,
    /if \(applyNightLights\) \{\s*computeDayColor \+= `\\\n\s*color\.rgb = applyNightLightsEmission\(color\.rgb, g_nightLightsLayerColor, nightBlend, u_dayTextureNightAlpha\[\$\{i\}\], u_dayTextureDayAlpha\[\$\{i\}\]\);\\n`;\s*\}/,
    "the define must actually generate a call, per layer",
  );
  // ...and the generated call must sit inside the per-layer loop rather than
  // after it, or only the last layer would ever glow.
  const loopStart = shaderSet.indexOf(
    "for (let i = 0; i < numberOfDayTextures; ++i) {",
  );
  const call = shaderSet.indexOf("applyNightLightsEmission(color.rgb");
  const loopEnd = shaderSet.indexOf("return color;", loopStart);
  assert.ok(loopStart >= 0 && call > loopStart && call < loopEnd);
});

test("D3: the emitting WebGL variant can only exist where its uniforms do", () => {
  // The generated call reads `u_dayTextureNightAlpha` / `u_dayTextureDayAlpha`,
  // which GlobeFS.glsl declares only under APPLY_DAY_NIGHT_ALPHA. Decoupling
  // the two options would therefore not merely change appearance — it would
  // generate a shader that does not compile. The conjunction is what forbids
  // that combination, so it is pinned as a property rather than as text.
  assert.match(
    glsl,
    /#ifdef APPLY_DAY_NIGHT_ALPHA\nuniform float u_dayTextureNightAlpha\[TEXTURE_UNITS\];\nuniform float u_dayTextureDayAlpha\[TEXTURE_UNITS\];\n#endif/,
  );
  const derive = tileRendering.match(
    /surfaceShaderSetOptions\.applyNightLights =\s*([^;]+);/,
  );
  assert.ok(derive);
  // eslint-disable-next-line no-new-func
  const armed = new Function(
    "nightLightsOn",
    "applyDayNightAlpha",
    `return ${derive[1]};`,
  );
  for (const nightLightsOn of [true, false]) {
    for (const applyDayNightAlpha of [true, false]) {
      assert.equal(
        armed(nightLightsOn, applyDayNightAlpha) === true,
        nightLightsOn && applyDayNightAlpha,
        "the emitting variant must imply the day/night alpha variant",
      );
    }
  }
  // The uniform the term reads is itself behind the define, so a non-emitting
  // globe's generated source is the one upstream emits.
  assert.match(
    glsl,
    /#ifdef APPLY_NIGHT_LIGHTS\nuniform float u_nightIntensity;/,
  );
});

test("D4: WebGPU runs the term on every unrolled layer slot", () => {
  const calls =
    stripLineComments(wgsl).match(
      /color = applyNightLightsEmission\(color, r\.adjustedColor, nightBlend, dna\.y, dna\.x\);/g,
    ) ?? [];
  assert.equal(
    calls.length,
    16,
    "one call per imagery slot; a short count silently drops layers",
  );
  // The enable reaches the packer, and the packer keeps it separate from the
  // value — the whole point of the sentinel.
  assert.match(
    tileUb,
    /const nightLightsOn = tileProvider\?\.enableNightLights !== false;/,
  );
  assert.match(
    globe,
    /tileProvider\.enableNightLights = this\.enableNightLights;/,
  );
  assert.match(globe, /tileProvider\.nightIntensity = this\.nightIntensity;/);
});

test("D5: the WebGL variant key separates the emitting shader from the rest", () => {
  const flag = shaderSet.match(/\(applyNightLights \? (0x[0-9a-f]+) : 0\)/);
  assert.ok(flag, "the option must contribute to the shader variant key");
  const bit = Number(flag[1]);
  assert.equal(bit & (bit - 1), 0, "the flag must be a single bit");
  assert.ok(bit > 0xffffffff, "high flags must sit above the 32-bit OR");
  // ...and must not collide with any other high flag.
  const highFlags = [...shaderSet.matchAll(/\? (0x[0-9a-f]{9,}) : 0\)/g)].map(
    (match) => Number(match[1]),
  );
  assert.equal(
    new Set(highFlags).size,
    highFlags.length,
    "two options sharing a bit would serve one shader for both",
  );
  assert.ok(highFlags.includes(bit));
});

// ─── E. MUTANTS — one source substituted, nothing written ───────────────────
//
// Every mutant below replaces ONE file's text for the length of one verdict and
// puts it back. Nothing is written to disk, deliberately: several specs in this
// fleet read these same files at module load, so a mutant that wrote one would
// race any concurrent run and hand another spec a source neither of them chose.
// E10 checks that nothing moved.
//
// The substitution is not a weaker mutation than a write. Every predicate in
// the verdict reads its source through one accessor, so a mutated source is the
// only source the verdict can see — which E9's control demonstrates by NOT
// flipping it.

const sourcesOnDisk = new Map();
for (const relativePath of [
  WGSL_PATH,
  GLSL_PATH,
  SHADER_SET_PATH,
  TILE_RENDERING_PATH,
  GLOBE_PATH,
]) {
  sourcesOnDisk.set(relativePath, fs.readFileSync(absolute(relativePath)));
}

/**
 * The whole spec as a predicate over a set of sources.
 *
 * `override` is consulted first, so a mutant's text is the only text this can
 * see for the file it names. A predicate closed over the module-level reads
 * would survive every mutation and prove nothing.
 */
function verdict(override) {
  const source = (relativePath) =>
    override?.path === relativePath ? override.text : read(relativePath);
  try {
    const wgslLaw = emissionLawFrom(source(WGSL_PATH), WGSL_PATTERNS);
    const glslLaw = emissionLawFrom(source(GLSL_PATH), GLSL_PATTERNS);
    if (maximumDivergence(wgslLaw, glslLaw) !== 0) {
      return false;
    }
    if (glslLaw.emission([1, 1, 1], 1, 1, 0, 2.5)[0] <= 0) {
      return false;
    }
    if (glslLaw.emission([1, 1, 1], 1, 1, 0, 0)[0] !== 0) {
      return false;
    }
    if (!/this\.enableNightLights = true;/.test(source(GLOBE_PATH))) {
      return false;
    }
    if (
      !/surfaceShaderSetOptions\.applyNightLights =\s*nightLightsOn && applyDayNightAlpha;/.test(
        source(TILE_RENDERING_PATH),
      )
    ) {
      return false;
    }
    const shaderSetSource = source(SHADER_SET_PATH);
    if (
      !/if \(applyNightLights\) \{\s*computeDayColor \+=/.test(shaderSetSource)
    ) {
      return false;
    }
    return /if \(applyNightLights\) \{\s*fs\.defines\.push\("APPLY_NIGHT_LIGHTS"\);/.test(
      shaderSetSource,
    );
  } catch {
    // An extraction that no longer finds its law throws, and a thrown
    // extraction is a failed verdict, not an error in the harness.
    return false;
  }
}

/**
 * Substitute one file's text for the length of one verdict.
 *
 * The needle is matched against the file normalised to bare newlines, because
 * this tree is CRLF and a needle written with bare newlines would otherwise
 * never match — reporting a green the mutant never earned.
 */
function withMutation(relativePath, from, to, expectation) {
  const text = sourcesOnDisk
    .get(relativePath)
    .toString("utf8")
    .replaceAll(CRLF, LF);
  assert.ok(
    text.includes(from),
    `mutation precondition failed in ${relativePath}: "${from.slice(0, 60)}..."`,
  );
  assert.equal(
    verdict({ path: relativePath, text: text.replace(from, to) }),
    expectation,
  );
}

test("E0: the verdict is TRUE on the shipped tree", () => {
  assert.equal(
    verdict(undefined),
    true,
    "a verdict that is false already proves nothing",
  );
});

test("E1: ABSENCE — the GLSL emission term deleted", () => {
  withMutation(
    GLSL_PATH,
    "    float nightIntensity = nightLightsIntensity();\n    vec3 emission = layerColor * lum * nightBlend * nightIntensity * isNightLayer;\n    return color + emission;",
    "    return color;",
    false,
  );
});

test("E2: INERTNESS — the term computed and thrown away", () => {
  // The shape a deletion mutant misses: every symbol is still present, the
  // function still returns a colour, and nothing glows.
  withMutation(
    GLSL_PATH,
    "    return color + emission;",
    "    return color + emission * 0.0;",
    false,
  );
});

test("E3: UNREACHABLE — the generated call switched off at the generator", () => {
  withMutation(
    SHADER_SET_PATH,
    "        if (applyNightLights) {\n          computeDayColor += `",
    "        if (false && applyNightLights) {\n          computeDayColor += `",
    false,
  );
});

test("E4: WRONG GATE — the alpha comparison reversed", () => {
  // The plausible typo. It leaves every ordinary layer glowing and every night
  // layer dark, and no absence mutant finds it.
  withMutation(
    GLSL_PATH,
    "    float isNightLayer = step(dayAlpha + 0.01, nightAlpha);",
    "    float isNightLayer = step(nightAlpha + 0.01, dayAlpha);",
    false,
  );
});

test("E5: WRONG WEIGHTS — the older luminance triple", () => {
  // `czm_luminance` is one call away and is the obvious thing to reach for; its
  // weights differ in the third decimal, which is invisible by eye and is a
  // permanent cross-backend divergence.
  withMutation(
    GLSL_PATH,
    "    float lum = dot(layerColor, vec3(0.2126, 0.7152, 0.0722));",
    "    float lum = dot(layerColor, vec3(0.2125, 0.7154, 0.0721));",
    false,
  );
});

test("E6: WRONG SENTINEL — zero read as absence again", () => {
  // The exact regression the negative marker was introduced to prevent.
  withMutation(
    GLSL_PATH,
    "    return u_nightIntensity < 0.0 ? 2.5 : u_nightIntensity;",
    "    return u_nightIntensity == 0.0 ? 2.5 : u_nightIntensity;",
    false,
  );
});

test("E7: DEFAULT REVERTED — the feature ships off again", () => {
  withMutation(
    GLOBE_PATH,
    "    this.enableNightLights = true;",
    "    this.enableNightLights = false;",
    false,
  );
});

test("E8: DECOUPLED — the emitting variant no longer implies its uniforms", () => {
  withMutation(
    TILE_RENDERING_PATH,
    "    surfaceShaderSetOptions.applyNightLights =\n      nightLightsOn && applyDayNightAlpha;",
    "    surfaceShaderSetOptions.applyNightLights = nightLightsOn;",
    false,
  );
});

test("E9: the mutants are discriminating, not merely destructive", () => {
  // A control: a change that touches the same lines without changing the law
  // must NOT flip the verdict, or the mutants above would be proving only that
  // the files can be broken.
  withMutation(
    GLSL_PATH,
    "    float isNightLayer = step(dayAlpha + 0.01, nightAlpha);",
    "    float isNightLayer = step(dayAlpha + 0.01, nightAlpha); // reordered\n",
    true,
  );
});

test("E10: no source file was written — every mutation was a substitution", () => {
  // Cheap, and it is the difference between a spec that leaves the tree clean
  // and one that leaves a mutant behind on a throw or races a concurrent run.
  for (const [relativePath, original] of sourcesOnDisk) {
    assert.equal(
      sha256(fs.readFileSync(absolute(relativePath))),
      sha256(original),
      `${relativePath} changed under the spec`,
    );
  }
});
