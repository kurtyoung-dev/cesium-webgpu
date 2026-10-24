// globe-classic-ocean-default-parity.spec.mjs - FIX_LIST_WATER WL-01, WL-02,
// WL-04, WL-06 and WL-08, BEHAVIOUR_WATER A3, C1 and C2; section H is the
// review's B1 (the globe material's water mask on the default hi word, held at base);
// section I is water rounds 5 and 6 (FND-1, FND-2, B1-wrap, N1): GlobeFS.glsl's waves
// and coast band in the opt-in WATER_PROVIDER_PARITY variant only; section J is
// water round 7 (FND-2): the parity taps read the ocean normal texture as WebGL
// reads it (level 0, bilinear, clamped), executed over a texel grid with a mip chain.
// @purpose Pins that a default globe (definesHi 0, enableEnhancedOcean false) draws the base ocean in GlobeTerrain.wgsl, that the opt-in WATER_PROVIDER_PARITY variant draws GlobeFS.glsl's classic waves (unwrapped clock, derivatives through the pole flip) and coast band (executed against the GLSL twin), that the enhanced water changes live only under ENHANCED_OCEAN, that the vessel-wake gate is its own camera lane, and that a globe material still receives the base waterMask under MATERIAL_APPLY (the water work's sample is held back; its GLSL-law control runs on a copy).
// @status ACTIVE
//
// WHAT THIS GUARDS. The Argon water work changed the shader a default WebGPU
// globe compiles: a 24-68 km wave law in place of the 70-1000 km quintic, a
// wider coast feather, a tide shift, a swash and wet-sand fringe, a bay
// sea-level gate and a wave-footprint guard. None has a GLSL twin, and
// `Globe.enableEnhancedOcean` is false by default, so none of it may reach the
// default variant. Every such change now sits under `//>>ifdef ENHANCED_OCEAN`
// with a `//>>else` arm equal to the base text (a999954e2b).
//
// HOW IT READS THE SHADER. The ENGINE's own preprocessor (`lib/wgsl-variant`)
// produces the text a pipeline compiles at definesHi 0, and the arithmetic
// blocks are then EXECUTED out of that text with `lib/wgsl-mini-eval`, so the
// numbers come from the shipped source. The reference is the base law, written
// here from the GLSL twin's own constants (`waveFade(70000, 1000000, ...)`) and
// the base WGSL expressions. Where the evaluator cannot run a block (a colour
// write inside an `if`), the check reads the preprocessed variant text and says
// so in its message.
//
// INERTNESS. Each law has a mutant that puts the unfixed text back (the new
// law in the default arm, the enhanced coast arm made unconditional, the wake
// gate derived from the preset, a wake that ignores the missing wiring) and the
// same check must go red on it. A check that stays green on its mutant proved
// nothing.
//
// LINE ENDINGS: this repo checks out CRLF; every read is normalised to `\n`.
//
// Run: node --test Tools/visual-regression/globe-classic-ocean-default-parity.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ShaderDefine,
  ShaderDefineHi,
  defaultVariant,
  hiVariant,
  preprocess,
} from "./lib/wgsl-variant.mjs";
import {
  compileFunction,
  evaluate,
  isVec,
  laneCount,
  laneValues,
  parseExpression,
  readConstants,
  stripComments,
  tokenize,
  vec,
  vec2,
  vec4,
} from "./lib/wgsl-mini-eval.mjs";
import {
  applyAnchors,
  assertInertnessMutantTurnsRed,
} from "./water-spec-mutants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const read = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const TERRAIN = "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const GLSL = "packages/engine/Source/Shaders/GlobeFS.glsl";
const CAMERA_UB =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts";

const terrain = read(TERRAIN);
const glsl = read(GLSL);
const cameraUb = read(CAMERA_UB);

const ENHANCED = ShaderDefineHi.ENHANCED_OCEAN;
// The opt-in parity ocean (water round 6, seat ruling R-2026-10-23-S8): set only
// while a water classification provider feeds the globe.
const PARITY = ShaderDefineHi.WATER_PROVIDER_PARITY;
const parityVariant = (text) => hiVariant(text, PARITY);

// ───────────────────────── reference arithmetic ─────────────────────────────

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const mix = (a, b, t) => a * (1 - t) + b * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// The GLSL twin's own wave-fade constants, read from GlobeFS.glsl rather than
// retyped, so the reference moves if the twin moves.
const glslFade =
  /waveFade\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*positionToEyeECLength\s*\)/.exec(
    glsl,
  );
assert.ok(
  glslFade,
  "GlobeFS.glsl must still compute waveIntensity with waveFade",
);
const FADE_NEAR = Number.parseFloat(glslFade[1]);
const FADE_FAR = Number.parseFloat(glslFade[2]);

/** The base wave law (a999954e2b): GLSL waveFade, and the WGSL near-surface strength. */
function baseWave(eyeDistance, distance) {
  const fade =
    (1 - clamp((eyeDistance - FADE_NEAR) / (FADE_FAR - FADE_NEAR), 0, 1)) ** 5;
  return {
    fade,
    strength: mix(0.85, 0.05, smoothstep(10000, 500000, distance)) * fade,
  };
}

/** The base coast coverage (a999954e2b). */
function baseCoverage(waterMask, maskScreenGrad) {
  const band = clamp(maskScreenGrad * 1.5, 0.2, 0.5);
  return smoothstep(0.5 - band, 0.5 + band, waterMask);
}

/** The base wave-footprint law (a999954e2b). */
function baseFootMin(lenDx, lenDy, maxAniso) {
  return Math.max(Math.min(lenDx, lenDy), Math.max(lenDx, lenDy) / maxAniso);
}

// ───────────────────────── executing the shader text ────────────────────────

const GLOBALS = { __functions: { mix } };

/** Evaluate a WGSL function out of a preprocessed variant. */
function functionOf(variantText, name, globals = {}) {
  return compileFunction(stripComments(variantText), name, {
    ...GLOBALS,
    ...globals,
  });
}

/** Evaluate straight-line `let` statements, returning one named binding. */
function blockValue(statements, returns, globals) {
  const source = stripComments(
    `fn probe() -> f32 {\n${statements}\nreturn ${returns};\n}`,
  ).replace(/,(\s*\))/g, "$1");
  return compileFunction(source, "probe", { ...GLOBALS, ...globals })();
}

// ───────────────────────── A. the wave law (WL-01) ──────────────────────────

/** Collect a finding, keeping the first few: a failed grid can be thousands. */
function report(list, finding) {
  if (list.length < 5) {
    list.push(finding);
  }
}

const ALTITUDES_M = [5000, 30000, 80000, 200000, 900000];

// ───────── the classic wave law of GlobeFS.glsl (water rounds 5-6) ───────────
//
// The opt-in WATER_PROVIDER_PARITY variant draws GlobeFS.glsl's waves: two
// czm_getWaterNoise layers over the blended ellipsoid texture coordinates
// (`classicOceanWaveNormal`). The reference below is written from the GLSL
// twin's own constants, read out of GlobeFS.glsl and getWaterNoise.glsl, so it
// moves if the twin moves; its texture-coordinate derivatives are finite
// differences of GlobeFS.glsl's blended coordinates (what dFdx returns), an
// independent route from the shader's chain rule.

const GET_WATER_NOISE = read(
  "packages/engine/Source/Shaders/Builtin/Functions/getWaterNoise.glsl",
);
const glslConst = (name) => {
  const m = new RegExp(`const float ${name} = ([^;]+);`).exec(glsl);
  assert.ok(m, `GlobeFS.glsl must define ${name}`);
  // eslint-disable-next-line no-new-func
  return Function(`return (${m[1]});`)();
};
const GLSL_WAVES = {
  freqLow: glslConst("oceanFrequencyLowAltitude"),
  speedLow: glslConst("oceanAnimationSpeedLowAltitude"),
  ampLow: glslConst("oceanOneOverAmplitudeLowAltitude"),
  freqHigh: glslConst("oceanFrequencyHighAltitude"),
  speedHigh: glslConst("oceanAnimationSpeedHighAltitude"),
  ampHigh: glslConst("oceanOneOverAmplitudeHighAltitude"),
  fps: glslConst("oceanWaveNominalFramesPerSecond"),
  divisor: glslConst("OCEAN_GETWATERNOISE_DIVISOR"),
  fadeLo: glslConst("OCEAN_OCTAVE_FADE_LO"),
  fadeHi: glslConst("OCEAN_OCTAVE_FADE_HI"),
  cutoff: glslConst("OCEAN_WAVE_MARCH_CUTOFF"),
};

/** czm_getWaterNoise's four taps (divisor, direction, offset), read from the GLSL. */
function glslNoiseTaps() {
  const num = (text) => {
    // eslint-disable-next-line no-new-func
    return Function(`return (${text});`)();
  };
  const pair = (text) => {
    const m = /^vec2\(([^,]+),([^)]+)\)$/.exec(text.replace(/\s+/g, ""));
    return m ? [num(m[1]), num(m[2])] : [num(text), num(text)];
  };
  const dirs = [0, 1, 2, 3].map((i) => {
    const m = new RegExp(`vec2 s${i} = (vec2\\([^;]+\\));`).exec(
      GET_WATER_NOISE,
    );
    assert.ok(m, `getWaterNoise.glsl must define s${i}`);
    return pair(m[1]);
  });
  const taps = [0, 1, 2, 3].map((i) => {
    const m = new RegExp(
      `vec2 uv${i} = \\(?uv\\s*/\\s*(vec2\\([^)]*\\)|[\\d.]+)\\)?\\s*\\+\\s*\\(time \\* s${i}\\)(?:\\s*\\+\\s*vec2\\(([\\d.]+)\\))?;`,
    ).exec(GET_WATER_NOISE);
    assert.ok(m, `getWaterNoise.glsl must define uv${i}`);
    return { divisor: pair(m[1]), dir: dirs[i], offset: m[2] ? num(m[2]) : 0 };
  });
  return taps;
}
const NOISE_TAPS = glslNoiseTaps();

const fract = (x) => x - Math.floor(x);

/** A deterministic stand-in for the ocean normal map: rgba in [0, 1] at (u, v). */
function syntheticNormalMap(u, v) {
  const t = 2 * Math.PI;
  return [
    0.5 + 0.4 * Math.sin(t * (3 * u + v)),
    0.5 + 0.4 * Math.cos(t * (5 * v - u)),
    0.8 + 0.1 * Math.sin(t * 7 * u),
    1,
  ];
}

/** GLSL czm_getWaterNoise(normalMap, uv, time, 0.0) over the synthetic map. */
function glslWaterNoise(uv, time) {
  const sum = [0, 0, 0, 0];
  for (const tap of NOISE_TAPS) {
    const u = fract(uv[0] / tap.divisor[0] + time * tap.dir[0] + tap.offset);
    const v = fract(uv[1] / tap.divisor[1] + time * tap.dir[1] + tap.offset);
    syntheticNormalMap(u, v).forEach((c, i) => {
      sum[i] += c;
    });
  }
  return sum.map((c) => (c / 4 - 0.5) * 2);
}

const lodWeight = (r) =>
  1 - smoothstep(GLSL_WAVES.fadeLo, GLSL_WAVES.fadeHi, r);

/**
 * GlobeFS.glsl computeWaterColor's SHOW_OCEAN_WAVES branch: the tangent-space
 * normal at texture coordinates `tc`, footprint `foot` (max axis), eye
 * distance `eye`, scene seconds `seconds`.
 */
function glslWaveNormal(tc, foot, eye, seconds) {
  const fade =
    (1 - clamp((eye - FADE_NEAR) / (FADE_FAR - FADE_NEAR), 0, 1)) ** 5;
  const hw = lodWeight((GLSL_WAVES.freqHigh / GLSL_WAVES.divisor) * foot);
  const lw = lodWeight((GLSL_WAVES.freqLow / GLSL_WAVES.divisor) * foot);
  const ha = clamp(eye / 60000, 0, 1);
  const la = 1 - clamp((eye - 20000) / 40000, 0, 1);
  if (ha * hw + la * lw < GLSL_WAVES.cutoff) {
    return [0, 0, 1];
  }
  const frames = seconds * GLSL_WAVES.fps;
  const nh = glslWaterNoise(
    [tc[0] * GLSL_WAVES.freqHigh, tc[1] * GLSL_WAVES.freqHigh],
    frames * GLSL_WAVES.speedHigh,
  );
  const nl = glslWaterNoise(
    [tc[0] * GLSL_WAVES.freqLow, tc[1] * GLSL_WAVES.freqLow],
    frames * GLSL_WAVES.speedLow,
  );
  const high = [nh[0] * hw, nh[1] * hw, nh[2] * GLSL_WAVES.ampHigh];
  const low = [nl[0] * lw, nl[1] * lw, nl[2] * GLSL_WAVES.ampLow];
  const n = [0, 1, 2].map((i) => ha * high[i] + la * low[i]);
  const len = Math.hypot(...n);
  const faded = [(n[0] / len) * fade, (n[1] / len) * fade, n[2] / len];
  const fl = Math.hypot(...faded);
  return faded.map((c) => c / fl);
}

/** A scalar builtin lifted over a mini-eval vector, for injection. */
function lift(fn) {
  return (...args) => {
    const v = args.find(isVec);
    if (!v) {
      return fn(...args);
    }
    const lanes = args.map((a) => (isVec(a) ? laneValues(a) : null));
    const n = laneCount(v);
    const out = Array.from({ length: n }, (ignored, i) =>
      fn(...args.map((a, k) => (lanes[k] ? lanes[k][i] : a))),
    );
    return n === 4 ? vec4(...out) : n === 3 ? vec(...out) : vec2(...out);
  };
}

/** A variant's `classicOceanWaveNormal`, executable, over the synthetic map. */
function classicWaveOf(variantText) {
  // The evaluator does not take a trailing comma in an argument list.
  const code = stripComments(variantText).replace(/,(\s*\))/g, "$1");
  assert.match(
    code,
    /\bfn classicOceanWaveNormal\(/,
    "the parity variant must carry the classic wave law",
  );
  const constants = readConstants(code);
  // The law under test here is the noise arithmetic, so the map is the
  // continuous synthetic one, read at the tap's coordinate whatever the level,
  // and its resolution is so fine that the tap's half-texel clamp moves no
  // coordinate by more than 3e-8. Section J tests the texture read itself.
  const pointSample = (map, sampler, uv) => {
    const [u, v] = laneValues(uv);
    return vec4(...syntheticNormalMap(u, v));
  };
  const injected = {
    mix: lift(mix),
    fract: lift(fract),
    atan2: lift(Math.atan2),
    asin: lift(Math.asin),
    textureSampleGrad: pointSample,
    textureSampleLevel: pointSample,
    textureDimensions: () => vec2(2 ** 24, 2 ** 24),
  };
  const common = {
    ...constants,
    oceanNormalMap: {},
    oceanNormalSampler: {},
    camera: { morphTime: 1 },
  };
  const tap = compileFunction(code, "classicWaterNoiseTap", {
    ...common,
    __functions: injected,
  });
  const noise = compileFunction(code, "classicWaterNoise", {
    ...common,
    __functions: { ...injected, classicWaterNoiseTap: tap },
  });
  const weight = compileFunction(code, "oceanOctaveLodWeight", {
    ...common,
    __functions: injected,
  });
  const flippedStep = compileFunction(code, "classicFlippedTcStep", {
    ...common,
    __functions: injected,
  });
  return compileFunction(code, "classicOceanWaveNormal", {
    ...common,
    __functions: {
      ...injected,
      classicWaterNoise: noise,
      oceanOctaveLodWeight: weight,
      classicFlippedTcStep: flippedStep,
    },
  });
}

/**
 * Points on the sphere (lon, lat in degrees), eye distances, scene seconds and
 * footprints the parity grid runs. 66 degrees sits in the pole-cap blend
 * (normalMC.z in [0.9, 0.95]); 75 and 80 degrees are fully flipped, where the
 * ellipsoid-coordinate step is 1 / cos(latitude) too large (N1). 8e-4 puts the
 * low layer inside its footprint fade, where that error shows.
 */
const WAVE_POINTS = [
  [-122.6, 37.7],
  [-40, 15],
  [10, -35],
  [150, 60],
  [60, 66],
  [30, 75],
  [-100, 80],
];
const WAVE_EYES_M = [3000, 25000, 50000, 150000];
const WAVE_SECONDS = [0, 7.25, 600, 1800.5];
const WAVE_FOOTPRINTS = [2e-9, 2e-7, 2e-6, 8e-4];

const unitNormal = (lon, lat) => [
  Math.cos(lat) * Math.cos(lon),
  Math.cos(lat) * Math.sin(lon),
  Math.sin(lat),
];

/** czm_ellipsoidTextureCoordinates. */
const ellipsoidTc = (n) => [
  Math.atan2(n[1], n[0]) / (2 * Math.PI) + 0.5,
  Math.asin(n[2]) / Math.PI + 0.5,
];

/** GlobeFS.glsl's textureCoordinates: the two parameterisations blended near the pole (czm_morphTime 1). */
function glslTextureCoordinates(lon, lat) {
  const n = unitNormal(lon, lat);
  const e = ellipsoidTc(n);
  const f = ellipsoidTc([n[2], n[1], n[0]]);
  const w = smoothstep(0.9, 0.95, n[2]);
  return [mix(e[0], f[0], w), mix(e[1], f[1], w)];
}

/**
 * dFdx of GlobeFS.glsl's textureCoordinates along a screen step whose
 * ellipsoid-coordinate change is `dE`: a central difference over a 1e-7 rad
 * step, scaled back to the step.
 */
function glslTcStep(lon, lat, dE) {
  const dLon = 2 * Math.PI * dE[0];
  const dLat = Math.PI * dE[1];
  const scale = Math.max(Math.abs(dLon), Math.abs(dLat));
  if (scale === 0) {
    return [0, 0];
  }
  const h = 1e-7 / scale;
  const a = glslTextureCoordinates(lon + h * dLon, lat + h * dLat);
  const b = glslTextureCoordinates(lon - h * dLon, lat - h * dLat);
  return [(a[0] - b[0]) / (2 * h), (a[1] - b[1]) / (2 * h)];
}

/** Disagreements between a variant's classic wave normal and GlobeFS.glsl's. */
function classicWaveMismatches(variantText, points = WAVE_POINTS) {
  const wave = classicWaveOf(variantText);
  const out = [];
  for (const [lonDeg, latDeg] of points) {
    const lon = (lonDeg * Math.PI) / 180;
    const lat = (latDeg * Math.PI) / 180;
    const n = unitNormal(lon, lat);
    const tc = glslTextureCoordinates(lon, lat);
    const positionMC = vec(n[0] * 6378137, n[1] * 6378137, n[2] * 6378137);
    for (const eye of WAVE_EYES_M) {
      for (const seconds of WAVE_SECONDS) {
        for (const foot of WAVE_FOOTPRINTS) {
          const dEx = [foot, 0];
          const dEy = [0, foot * 0.5];
          const tx = glslTcStep(lon, lat, dEx);
          const ty = glslTcStep(lon, lat, dEy);
          const glslFoot = Math.max(Math.hypot(...tx), Math.hypot(...ty));
          const got = laneValues(
            wave(positionMC, vec2(...dEx), vec2(...dEy), eye, seconds),
          );
          const want = glslWaveNormal(tc, glslFoot, eye, seconds);
          const err = Math.max(...got.map((c, i) => Math.abs(c - want[i])));
          if (!(err < 1e-6)) {
            report(
              out,
              `(${lonDeg}, ${latDeg}) eye ${eye} t ${seconds} foot ${foot}: [${got.map((c) => c.toFixed(5))}] vs GLSL [${want.map((c) => c.toFixed(5))}]`,
            );
          }
        }
      }
    }
  }
  return out;
}

/** The classic law's fade (the normal's tilt at a flat-in-footprint point) against waveFade(70 km, 1000 km). */
function classicFadeMismatches(variantText) {
  const out = [];
  const code = stripComments(variantText);
  const block =
    /let waveIntensity = pow\(1\.0 - clamp\(\(eyeDistance - ([\d.]+)\) \/ \(([\d.]+) - ([\d.]+)\), 0\.0, 1\.0\), 5\.0\);/.exec(
      code,
    );
  if (!block) {
    return ["the default variant carries no classic wave fade"];
  }
  for (const d of ALTITUDES_M) {
    const got = blockValue(block[0], "waveIntensity", { eyeDistance: d });
    const want = baseWave(d, d).fade;
    if (Math.abs(got - want) > 1e-9) {
      report(out, `fade at ${d} m: ${got} vs GLSL ${want}`);
    }
  }
  return out;
}

// Since W-A1 the default variant carries the shipped inline law (the base
// text) inside `computeEnhancedOcean`, and `oceanWaveFade` exists only under
// ENHANCED_OCEAN. These are the inline statements, executed out of the variant.
const INLINE_WAVE =
  /let waveFadeLin = clamp\([\s\S]*?\);\s*let waveIntensityFade = [^;]+;\s*let waveStrength = [^;]+;/;
const INLINE_CLASSIC =
  /let classicPositionToEyeECLength = [^;]+;\s*let classicWaveFadeLin = clamp\([\s\S]*?\);\s*let classicWaveIntensity = [^;]+;/;

/** The variant's inline wave law as `(eyeDistance, distance) -> {x, y}`. */
function inlineWaveLaw(variantText) {
  const block = INLINE_WAVE.exec(stripComments(variantText));
  assert.ok(block, "the default variant must carry the inline wave law");
  return (eyeDistance, distance) => {
    const globals = { positionEC: vec(0, 0, -eyeDistance), distance };
    return {
      x: blockValue(block[0], "waveIntensityFade", globals),
      y: blockValue(block[0], "waveStrength", globals),
    };
  };
}

/**
 * Every disagreement between a variant's wave law (`oceanWaveFade`, or the
 * inline law of the default variant) and the base law at the five altitudes;
 * empty when the variant IS the base law.
 */
function waveLawMismatches(variantText) {
  const wave = /\bfn oceanWaveFade\(/.test(variantText)
    ? functionOf(variantText, "oceanWaveFade")
    : inlineWaveLaw(variantText);
  const out = [];
  for (const d of ALTITUDES_M) {
    const got = wave(d, d);
    const want = baseWave(d, d);
    if (Math.abs(got.x - want.fade) > 1e-9) {
      report(out, `fade at ${d} m: ${got.x} vs base ${want.fade}`);
    }
    if (Math.abs(got.y - want.strength) > 1e-9) {
      report(out, `strength at ${d} m: ${got.y} vs base ${want.strength}`);
    }
  }
  return out;
}

test("A1: the GLSL twin still fades the waves between 70 km and 1000 km", () => {
  assert.equal(FADE_NEAR, 70000);
  assert.equal(FADE_FAR, 1000000);
});

test("A2: the default variant's wave fade and strength equal the base law at 5, 30, 80, 200 and 900 km", () => {
  assert.deepEqual(waveLawMismatches(defaultVariant(terrain)), []);
  // The classic law is the opt-in parity variant's only (section I).
  assert.doesNotMatch(defaultVariant(terrain), /classicOceanWaveNormal/);
});

test("A2p: the parity variant's wave fade is GlobeFS.glsl's at 5, 30, 80, 200 and 900 km (the classic law, executed out of the variant)", () => {
  assert.deepEqual(classicFadeMismatches(parityVariant(terrain)), []);
  // The base WGSL inline law is gone from the parity variant: it runs
  // GlobeFS.glsl's two czm_getWaterNoise layers (section I).
  assert.doesNotMatch(
    stripComments(parityVariant(terrain)),
    /let waveStrength = mix\(0\.85, 0\.05/,
  );
});

test("A3: the 24-68 km law exists only under ENHANCED_OCEAN, and differs from the base where it should", () => {
  const enhanced = functionOf(hiVariant(terrain, ENHANCED), "oceanWaveFade");
  // Control: at 80 km the base fade is still about 0.95 and the enhanced one
  // is already 0, so the check above can tell the two laws apart.
  assert.ok(baseWave(80000, 80000).fade > 0.9);
  assert.equal(enhanced(80000, 80000).x, 0);
  assert.equal(enhanced(5000, 5000).x, 1);
  assert.notEqual(
    waveLawMismatches(hiVariant(terrain, ENHANCED)).length,
    0,
    "the enhanced arm is a different law; if it equals the base the arm is dead weight",
  );
});

test("A4: the default and parity arms carry no enhanced skip floor, the enhanced arm skips the invisible tail", () => {
  // The base marched whenever the waves were on, at every distance: the
  // default variant gates the march on `showOceanWaves` alone, and the parity
  // variant on it and the GLSL twin's own OCEAN_WAVE_MARCH_CUTOFF inside
  // `classicOceanWaveNormal` (I1 executes it). Neither carries the enhanced
  // skip floor. The enhanced floor is not negative, so fade 0 is skipped.
  for (const code of [
    stripComments(defaultVariant(terrain)),
    stripComments(parityVariant(terrain)),
  ]) {
    assert.match(code, /if \(showOceanWaves\) \{/);
    assert.doesNotMatch(code, /oceanWaveSkipFloor/);
  }
  const floor = functionOf(
    hiVariant(terrain, ENHANCED),
    "oceanWaveSkipFloor",
  )();
  assert.ok(!(0 > floor));
});

test("A5: the classic arm's wave intensity equals the base law (executed out of the variant text)", () => {
  const block = INLINE_CLASSIC.exec(stripComments(defaultVariant(terrain)));
  assert.ok(block, "the classic arm must compute its own wave intensity");
  for (const d of ALTITUDES_M) {
    const got = blockValue(block[0], "classicWaveIntensity", {
      positionEC: vec(0, 0, -d),
    });
    assert.ok(Math.abs(got - baseWave(d, d).fade) < 1e-9, `at ${d} m`);
  }
});

test("A6 (mutant): the new law in the default arm is DETECTED", () => {
  const mutant = terrain.replace(
    "      (length(positionEC) - 70000.0) / (1000000.0 - 70000.0),",
    "      (length(positionEC) - 24000.0) / (68000.0 - 24000.0),",
  );
  assert.notEqual(
    mutant,
    terrain,
    "mutation precondition: the default arm changed",
  );
  assert.notEqual(waveLawMismatches(defaultVariant(mutant)).length, 0);
});

test("A6p (mutant): the 24-68 km law in the parity arm is DETECTED", () => {
  const mutant = terrain.replace(
    "let waveIntensity = pow(1.0 - clamp((eyeDistance - 70000.0) / (1000000.0 - 70000.0), 0.0, 1.0), 5.0);",
    "let waveIntensity = pow(1.0 - clamp((eyeDistance - 24000.0) / (68000.0 - 24000.0), 0.0, 1.0), 5.0);",
  );
  assert.notEqual(
    mutant,
    terrain,
    "mutation precondition: the parity arm changed",
  );
  assert.notEqual(classicFadeMismatches(parityVariant(mutant)).length, 0);
});

// ───────────────────── B. the coast (WL-02) ─────────────────────────────────

const COAST_BLOCK = /let coastBand = [^;]+;[\s\S]*?let coastCoverage = [^;]+;/;
const MASKS = [0, 0.1, 0.3, 0.45, 0.5, 0.55, 0.7, 0.9, 1];
const GRADS = [0, 0.05, 0.2, 0.4, 1];
const TIDES_M = [-3, -1, 0, 1, 3];
const CLOCKS_S = [0, 1000.5];
const DISTANCES_M = [500, 12000, 50000];
const HEIGHTS_M = [0, 1, 5];

/** Coast coverage disagreements with the base law over (mask, grad, tide, time, distance, height). */
function coastMismatches(variantText) {
  const stripped = stripComments(variantText);
  const block = COAST_BLOCK.exec(stripped);
  assert.ok(block, "the coast coverage block must exist in the variant");
  const out = [];
  for (const waterMask of MASKS) {
    for (const maskScreenGrad of GRADS) {
      for (const tide of TIDES_M) {
        for (const time of CLOCKS_S) {
          for (const vDistance of DISTANCES_M) {
            for (const safeFragHeight of HEIGHTS_M) {
              const got = blockValue(block[0], "coastCoverage", {
                waterMask,
                maskScreenGrad,
                maskFwidth: maskScreenGrad,
                safeFragHeight,
                tile: { oceanTideHeight: tide, time },
                input: { v_distance: vDistance },
              });
              const want = baseCoverage(waterMask, maskScreenGrad);
              if (Math.abs(got - want) > 1e-9) {
                report(
                  out,
                  `mask ${waterMask} grad ${maskScreenGrad} tide ${tide}: ${got} vs base ${want}`,
                );
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** The source with the ENHANCED_OCEAN arm that holds `anchor` made unconditional. */
function enhancedArmUnconditional(source, anchor) {
  const lines = source.split("\n");
  const at = lines.findIndex((line) => line.includes(anchor));
  assert.ok(at >= 0, `anchor not found: ${anchor}`);
  let open = at;
  while (!/^\s*\/\/>>ifdef ENHANCED_OCEAN\b/.test(lines[open])) {
    open -= 1;
    assert.ok(open >= 0, "no enclosing ifdef");
  }
  // The arm ends at the first `else` or `endif` after the anchor; a block with
  // no `else` simply loses its closing directive. Bounded, so a malformed
  // source fails instead of spinning.
  let end = at;
  while (end < lines.length && !/^\s*\/\/>>(else|endif)\b/.test(lines[end])) {
    end += 1;
  }
  assert.ok(end < lines.length, "no closing directive after the anchor");
  const elseAt = end;
  if (/^\s*\/\/>>else\b/.test(lines[end])) {
    // The else arm may hold nested blocks (the opt-in parity split, water
    // round 6): its endif is the first one at depth 0.
    let depth = 0;
    end += 1;
    while (end < lines.length) {
      if (/^\s*\/\/>>ifdef\b/.test(lines[end])) {
        depth += 1;
      } else if (/^\s*\/\/>>endif\b/.test(lines[end])) {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
      end += 1;
    }
    assert.ok(end < lines.length, "no endif after the else");
  }
  return [
    ...lines.slice(0, open),
    ...lines.slice(open + 1, elseAt),
    ...lines.slice(end + 1),
  ].join("\n");
}

test("B1: the default variant's coast coverage equals the base for every mask, gradient, tide and time; the parity variant's is GlobeFS.glsl's smoothstep(0.5 -+ clamp(fwidth(mask) * 1.5, 0.2, 0.5))", () => {
  assert.deepEqual(coastMismatches(defaultVariant(terrain)), []);
  assert.deepEqual(coastMismatches(parityVariant(terrain)), []);
});

test("B2: the enhanced arm moves the coast with the tide and widens the feather; the control proves the grid can see it", () => {
  assert.notEqual(coastMismatches(hiVariant(terrain, ENHANCED)).length, 0);
});

// P3-N2 (pass-2 S1/S2): the two consumers of tile float 493 in the enhanced arm,
// executed out of the enhanced variant. B2 alone cannot see a zeroed tide
// coefficient, because the widened feather still differs from the base.

/** Enhanced coast coverage at one (mask, tide) near the shore. */
function enhancedCoastCoverage(text, waterMask, tide) {
  const block = COAST_BLOCK.exec(stripComments(hiVariant(text, ENHANCED)));
  assert.ok(block, "the enhanced coast block must exist");
  return blockValue(block[0], "coastCoverage", {
    waterMask,
    maskScreenGrad: 0,
    safeFragHeight: 0,
    tile: { oceanTideHeight: tide, time: 0 },
    input: { v_distance: 50000 },
  });
}

const TIDAL_BLOCK =
  /let tidalCoastGate =[\s\S]*?let tidalShift = [^;]+;\s*let tidalWaterMask = [^;]+;/;

/** The enhanced ocean's tide-shifted mask at one (mask, tide) on a beach. */
function enhancedTidalMask(text, waterMaskValue, tide) {
  const code = stripComments(hiVariant(text, ENHANCED));
  const block = TIDAL_BLOCK.exec(code);
  assert.ok(block, "the enhanced tidal block must exist");
  assert.match(code, /smoothstep\(0\.16, 0\.84, tidalWaterMask\)/);
  return blockValue(block[0], "tidalWaterMask", {
    waterMaskValue,
    bedHeight: 0,
    multiBiomeGate: 0,
    tile: { oceanTideHeight: tide },
  });
}

test("B2b (S2): a +3 m tide raises the enhanced coast coverage at the shore and a -3 m tide lowers it", () => {
  const still = enhancedCoastCoverage(terrain, 0.5, 0);
  assert.ok(enhancedCoastCoverage(terrain, 0.5, 3) > still + 0.05);
  assert.ok(enhancedCoastCoverage(terrain, 0.5, -3) < still - 0.05);
});

test("B2c (S1): the enhanced ocean shifts its water mask with the tide on a low beach", () => {
  assert.ok(enhancedTidalMask(terrain, 0.55, 3) > 0.55 + 0.05);
  assert.ok(enhancedTidalMask(terrain, 0.55, -3) < 0.55 - 0.05);
});

test("B2d (mutants S1, S2): a zeroed tide coefficient at either site is DETECTED", () => {
  const s2 = terrain.replace(
    "let tideShift = clamp(tile.oceanTideHeight * 0.05,",
    "let tideShift = clamp(tile.oceanTideHeight * 0.0,",
  );
  assert.notEqual(s2, terrain, "S2 precondition");
  assert.ok(
    !(
      enhancedCoastCoverage(s2, 0.5, 3) >
      enhancedCoastCoverage(s2, 0.5, 0) + 0.05
    ),
  );
  const s1 = terrain.replace(
    "let tidalShift = clamp(tile.oceanTideHeight * 0.045,",
    "let tidalShift = clamp(tile.oceanTideHeight * 0.0,",
  );
  assert.notEqual(s1, terrain, "S1 precondition");
  assert.ok(!(enhancedTidalMask(s1, 0.55, 3) > 0.55 + 0.05));
});

test("B3 (mutant): the enhanced coast arm made unconditional is DETECTED", () => {
  const mutant = enhancedArmUnconditional(terrain, "let coastalTideGate =");
  assert.notEqual(coastMismatches(defaultVariant(mutant)).length, 0);
});

test("B4 (mutant): the old 0.22 floor in the default arm is DETECTED", () => {
  const mutant = terrain.replace(
    "let coastBand = clamp(maskScreenGrad * 1.5, 0.2, 0.5);",
    "let coastBand = clamp(max(maskScreenGrad * 1.5, 0.22), 0.22, 0.5);",
  );
  assert.notEqual(mutant, terrain);
  assert.notEqual(coastMismatches(defaultVariant(mutant)).length, 0);
});

test("B4p (mutant): the old 0.22 floor in the parity arm is DETECTED", () => {
  const mutant = terrain.replace(
    "let coastBand = clamp(maskFwidth * 1.5, 0.2, 0.5);",
    "let coastBand = clamp(max(maskFwidth * 1.5, 0.22), 0.22, 0.5);",
  );
  assert.notEqual(mutant, terrain);
  assert.notEqual(coastMismatches(parityVariant(mutant)).length, 0);
});

/** Tokens of the enhanced-only coast work that must not exist in the default variant. */
const ENHANCED_ONLY_COAST = [
  "baySeaLevelGate",
  "swashRunup",
  "wetSandUpper",
  "wetIntertidalFactor",
  "thinFilmSpec",
  "coastalTideGate",
];

function leakedCoastTokens(variantText) {
  const code = stripComments(variantText);
  return ENHANCED_ONLY_COAST.filter((token) => code.includes(token));
}

test("B5: the default variant carries no bay gate, tide shift, swash or wet-sand fringe (variant text)", () => {
  assert.deepEqual(leakedCoastTokens(defaultVariant(terrain)), []);
  assert.match(
    defaultVariant(terrain),
    /let waterMask = textureSampleLevel\(waterMaskTexture, waterMaskSampler, waterUV, 0\.0\)\.r;/,
    "the default classic mask is the raw sample (the base statement)",
  );
  // Control: the enhanced variant does carry them.
  assert.deepEqual(
    leakedCoastTokens(hiVariant(terrain, ENHANCED)).sort(),
    [...ENHANCED_ONLY_COAST].sort(),
  );
});

test("B6 (mutant): the wet-sand fringe made unconditional is DETECTED", () => {
  const mutant = enhancedArmUnconditional(terrain, "let swashRunup =");
  assert.notEqual(leakedCoastTokens(defaultVariant(mutant)).length, 0);
});

/** Tokens of the enhanced ocean's cloud-shadow glint coupling. */
const ENHANCED_ONLY_CLOUD_OCEAN = [
  "glintExcess",
  "cloudOcclusion",
  "coolSkyAmbient",
];

function leakedCloudOceanTokens(variantText) {
  const code = stripComments(variantText);
  return ENHANCED_ONLY_CLOUD_OCEAN.filter((token) => code.includes(token));
}

test("B7: under a cloud shadow the default ocean is mixed in exactly as at base; the glint coupling is enhanced only (variant text)", () => {
  // Lead fix at freeze: the coupling sat outside every ifdef, so a classic
  // ocean under a volumetric-cloud shadow changed look. Base mixes the plain
  // ocean colour and leaves the shadow to the general cloud-shadow multiply.
  assert.deepEqual(leakedCloudOceanTokens(defaultVariant(terrain)), []);
  assert.match(
    stripComments(defaultVariant(terrain)),
    /color = mix\(color, oceanColor, coastCoverage\);/,
  );
  // Control: the enhanced variant carries the coupling.
  assert.deepEqual(
    leakedCloudOceanTokens(hiVariant(terrain, ENHANCED)).sort(),
    [...ENHANCED_ONLY_CLOUD_OCEAN].sort(),
  );
});

test("B8 (mutant): the cloud-shadow glint coupling made unconditional is DETECTED", () => {
  const mutant = enhancedArmUnconditional(terrain, "let glintExcess =");
  assert.notEqual(leakedCloudOceanTokens(defaultVariant(mutant)).length, 0);
});

// ───────────────────── C. the wave footprint (WL-02) ────────────────────────

const aniso = Number.parseFloat(
  /const OCEAN_SAMPLER_MAX_ANISO: f32 = ([\d.]+);/.exec(terrain)?.[1],
);
const FOOTPRINT_BLOCK = /let (?:lenDx|footMinRaw)[\s\S]*?let footMin = [^;]+;/;
// (dx, dy) pairs: ordinary, anisotropic, and the degenerate case the enhanced
// guard exists for, where the two derivative vectors are parallel.
const FOOTPRINTS = [
  [
    [1e-3, 0],
    [0, 1e-3],
  ],
  [
    [4e-3, 0],
    [0, 1e-3],
  ],
  [
    [1e-3, 0],
    [2e-3, 0],
  ],
  [
    [1e-3, 1e-3],
    [2e-3, 2e-3],
  ],
  [
    [5e-4, 0],
    [0, 6e-3],
  ],
];

function footprintMismatches(variantText) {
  const block = FOOTPRINT_BLOCK.exec(stripComments(variantText));
  assert.ok(block, "the footprint block must exist in the variant");
  const out = [];
  for (const [dx, dy] of FOOTPRINTS) {
    const got = blockValue(block[0], "footMin", {
      euvDx: vec2(dx[0], dx[1]),
      euvDy: vec2(dy[0], dy[1]),
      OCEAN_SAMPLER_MAX_ANISO: aniso,
    });
    const want = baseFootMin(Math.hypot(...dx), Math.hypot(...dy), aniso);
    if (Math.abs(got - want) > 1e-12) {
      report(out, `dx ${dx} dy ${dy}: ${got} vs base ${want}`);
    }
  }
  return out;
}

test("C1: the default variant's wave-footprint LOD equals the base, parallel derivatives included", () => {
  assert.ok(Number.isFinite(aniso) && aniso > 1);
  assert.deepEqual(footprintMismatches(defaultVariant(terrain)), []);
  // Control: the enhanced guard differs on the degenerate pair.
  assert.notEqual(footprintMismatches(hiVariant(terrain, ENHANCED)).length, 0);
});

test("C2 (mutant): the degenerate-footprint guard in the default arm is DETECTED", () => {
  const mutant = enhancedArmUnconditional(terrain, "let safeFootMin = select(");
  assert.notEqual(footprintMismatches(defaultVariant(mutant)).length, 0);
});

// ───────────────────── D. the wake gate is its own lane (WL-04) ─────────────

/** `resolveWaterCameraControls`, lifted out of the TypeScript and run. */
function liftResolver(source) {
  const start = source.indexOf("export function resolveWaterCameraControls(");
  assert.notEqual(start, -1, "resolveWaterCameraControls must exist");
  const open = source.indexOf(
    "{",
    source.indexOf("): WaterCameraControls", start),
  );
  let depth = 0;
  let close = open;
  for (; close < source.length; close += 1) {
    if (source[close] === "{") {
      depth += 1;
    } else if (source[close] === "}" && (depth -= 1) === 0) {
      break;
    }
  }
  // eslint-disable-next-line no-new-func
  return new Function("source", source.slice(open + 1, close));
}

/** Every way the lifted packer lets the preset or the relief boost raise the wake. */
function wakeGateFailures(source) {
  const resolve = liftResolver(source);
  const out = [];
  for (const preset of ["LOW", "MEDIUM", "HIGH", undefined]) {
    for (const relief of [0, 1, 2]) {
      for (const intensity of [0, 1, 2]) {
        const c = resolve({
          waterQualityPreset: preset,
          waterBathymetricReliefBoost: relief,
          waterVesselWakeIntensity: intensity,
          waterVesselWakeEmittersWired: false,
        });
        if (c.vesselWakeGate !== 0) {
          report(
            out,
            `preset ${preset} relief ${relief} intensity ${intensity} -> gate ${c.vesselWakeGate}`,
          );
        }
      }
    }
  }
  return out;
}

test("D1: HIGH preset plus relief boost 2 with the wake off packs a wake gate of exactly 0", () => {
  const resolve = liftResolver(cameraUb);
  const c = resolve({
    waterQualityPreset: "HIGH",
    waterBathymetricReliefBoost: 2,
    waterVesselWakeIntensity: 0,
  });
  assert.equal(c.vesselWakeGate, 0);
  // hdrControl.z keeps the preset and the relief boost, and only those.
  assert.equal(c.detailBias, 0.45 + 1.0);
});

test("D2: no preset, relief or wake intensity raises the gate while no emitter is wired", () => {
  assert.deepEqual(wakeGateFailures(cameraUb), []);
});

test("D3: the gate opens only for an enabled wake with a wired emitter", () => {
  const resolve = liftResolver(cameraUb);
  assert.equal(
    resolve({ waterVesselWakeIntensity: 1, waterVesselWakeEmittersWired: true })
      .vesselWakeGate,
    0.5,
  );
  assert.equal(
    resolve({ waterVesselWakeIntensity: 0, waterVesselWakeEmittersWired: true })
      .vesselWakeGate,
    0,
  );
  assert.equal(
    resolve({ waterVesselWakeIntensity: 9, waterVesselWakeEmittersWired: true })
      .vesselWakeGate,
    1,
  );
});

test("D4: the wake gate the shader reads ignores hdrControl.z", () => {
  const read = /let dynamicWakeControl = ([^;]+);/.exec(
    stripComments(defaultVariant(terrain)) +
      stripComments(hiVariant(terrain, ENHANCED)),
  );
  assert.ok(read, "the wake gate statement must exist in the enhanced variant");
  const gate = (vesselWakeGate, z) =>
    blockValue(`let dynamicWakeControl = ${read[1]};`, "dynamicWakeControl", {
      camera: {
        vesselWakeGate,
        hdrControl: { x: 0, y: 2.2, z, w: 0 },
      },
    });
  for (const z of [-0.35, 0, 0.45, 1.45]) {
    assert.equal(gate(0, z), 0, `hdrControl.z ${z} must not open the wake`);
    assert.equal(gate(0.5, z), 0.5);
  }
});

test("D5 (mutant): a gate derived from the preset is DETECTED", () => {
  const mutant = cameraUb.replace(
    /vesselWakeGate:\s*source\.waterVesselWakeEmittersWired === true\s*\? Math\.min\(1\.0, wakeIntensity \* 0\.5\)\s*: 0\.0,/,
    "vesselWakeGate: Math.max(0.0, presetDelta + reliefDelta),",
  );
  assert.notEqual(mutant, cameraUb, "mutation precondition: the gate changed");
  assert.notEqual(wakeGateFailures(mutant).length, 0);
});

test("D6 (mutant): a wake gate that ignores the missing emitter wiring is DETECTED", () => {
  const mutant = cameraUb.replace(
    "source.waterVesselWakeEmittersWired === true",
    "true",
  );
  assert.notEqual(mutant, cameraUb);
  assert.notEqual(wakeGateFailures(mutant).length, 0);
});

// P3-N2 (pass-2 P10, BEHAVIOUR C2): `hdrControl.w` is ONE sign-coded float,
// positive = the ROV lamp, negative = minus the emergence wetness. The packer and
// the shader's two decoders are executed against each other.
const UNDERWATER = ShaderDefineHi.UNDERWATER_OPTICS;

/** The shader's decode of `hdrControl.w`, executed out of the underwater variant. */
function decodeLampOrWetness(w) {
  const code = stripComments(hiVariant(terrain, ENHANCED | UNDERWATER));
  const wet = /let emergenceWetness = ([^;]+);/.exec(code);
  const lamp = /let rovSpotlightGain = ([^;]+);/.exec(code);
  assert.ok(wet && lamp, "both decoders must exist in the underwater variant");
  const globals = {
    camera: { hdrControl: { x: 0, y: 2.2, z: 0, w } },
    __functions: { mix, step: (edge, x) => (x < edge ? 0 : 1) },
  };
  return {
    wetness: blockValue(`let v = ${wet[1]};`, "v", globals),
    lamp: blockValue(`let v = ${lamp[1]};`, "v", globals),
  };
}

/** Every round-trip disagreement of the C2 coding over lamp x wetness. */
function lampWetnessFailures(source) {
  const resolve = liftResolver(source);
  const out = [];
  for (const wetness of [0, 0.25, 0.6, 1]) {
    for (const lampOn of [false, true]) {
      const w = resolve({
        waterEmergenceWetness: wetness,
        waterSubmersibleLightEnabled: lampOn,
        waterSubmersibleLightIntensity: 2,
      }).lampOrWetness;
      const got = decodeLampOrWetness(w);
      // The lamp wins: wetness reads 0 while the lamp is on (known limitation).
      const wantWet = lampOn ? 0 : wetness;
      const wantLamp = lampOn ? 2 : 0.25;
      if (Math.abs(got.wetness - wantWet) > 1e-9) {
        report(
          out,
          `lamp ${lampOn} wetness ${wetness}: decoded ${got.wetness}`,
        );
      }
      if (Math.abs(got.lamp - wantLamp) > 1e-9) {
        report(out, `lamp ${lampOn} wetness ${wetness}: lamp ${got.lamp}`);
      }
    }
  }
  return out;
}

test("D6b: P3-N2 the C2 sign coding round-trips: the packer's lamp and wetness are what the shader decodes", () => {
  assert.deepEqual(lampWetnessFailures(cameraUb), []);
});

test("D6c (mutant Q11): the emergence wetness encoded with the lamp's sign is DETECTED", () => {
  const mutant = cameraUb.replace(
    "        ? -emergenceWet\n",
    "        ? emergenceWet\n",
  );
  assert.notEqual(mutant, cameraUb, "mutation precondition: the sign changed");
  assert.notEqual(lampWetnessFailures(mutant).length, 0);
});

test("D7: the lanes keep their order, and the former pad words are named (WL-05)", () => {
  const struct = /struct CameraUniforms \{([\s\S]*?)\n\};/.exec(
    stripComments(terrain),
  );
  assert.ok(struct);
  const names = struct[1]
    .split("\n")
    .map((line) => /^\s*(\w+)\s*:/.exec(line)?.[1])
    .filter(Boolean);
  const after = (name) => names[names.indexOf(name) + 1];
  assert.equal(after("ellipsoidRadius"), "vesselWakeGate");
  assert.equal(after("useWebMercator"), "oceanTransitionDeficit");
  assert.ok(!names.includes("_pad3") && !names.includes("_pad4"));
  assert.match(
    cameraUb,
    /data\[offset\+\+\] = ellipsoid\?\.maximumRadius \?\? 0\.0;\n\s*data\[offset\+\+\] = waterControls\.vesselWakeGate;/,
    "the packer writes the gate in the slot after the ellipsoid radius",
  );
});

// ───────────────────── E. dead GLSL block (WL-06) ───────────────────────────

const deadMacro = (text) => text.includes("SHOW_ENHANCED_OCEAN_OPTICS");

test("E1: GlobeFS.glsl carries no SHOW_ENHANCED_OCEAN_OPTICS block, because nothing defines that macro", () => {
  assert.equal(deadMacro(glsl), false);
});

test("E2 (mutant): the dead block put back is DETECTED", () => {
  assert.equal(
    deadMacro(`${glsl}\n#ifdef SHOW_ENHANCED_OCEAN_OPTICS\n#endif\n`),
    true,
  );
});

// ───────────────────── F. ellipsoid constants (WL-08) ───────────────────────

const WGS84 = { x: 6378137, z: 6356752.314245179 };

function ellipsoidConstants(variantText, inverseRadii) {
  const camera = {
    ellipsoidInverseRadiiX: 1 / inverseRadii.x,
    ellipsoidInverseRadiiY: 1 / inverseRadii.x,
    ellipsoidInverseRadiiZ: 1 / inverseRadii.z,
  };
  return {
    zScale: functionOf(variantText, "ellipsoidGeodeticZScale", { camera })(),
    meanRadius: functionOf(variantText, "ellipsoidMeanRadius", { camera })(),
  };
}

test("F1: the geodetic z scale and mean radius come from the ellipsoid uniforms, for WGS84 and for a sphere", () => {
  // Both helpers are enhanced only since W-A1 (no default-variant consumer).
  const text = hiVariant(terrain, ENHANCED);
  assert.doesNotMatch(
    stripComments(defaultVariant(terrain)),
    /ellipsoidGeodeticZScale|ellipsoidMeanRadius/,
  );
  const earth = ellipsoidConstants(text, WGS84);
  assert.ok(Math.abs(earth.zScale - 1.00673949674) < 1e-9);
  assert.ok(Math.abs(earth.meanRadius - 6371008.77) < 1);
  const moon = ellipsoidConstants(text, { x: 1737400, z: 1737400 });
  assert.ok(Math.abs(moon.zScale - 1) < 1e-12);
  assert.ok(Math.abs(moon.meanRadius - 1737400) < 1e-6);
});

/** WGS84 literals and smoothstep calls whose literal edges run backwards. */
function shaderHygieneFindings(source) {
  const code = stripComments(source);
  const out = [];
  for (const m of code.matchAll(/1\.00673949674|6371000\.0/g)) {
    report(out, `WGS84 literal ${m[0]}`);
  }
  const edges =
    /smoothstep\(\s*(-?[\d.]+(?:e-?\d+)?)\s*,\s*(-?[\d.]+(?:e-?\d+)?)\s*,/g;
  for (const m of code.matchAll(edges)) {
    if (Number.parseFloat(m[1]) > Number.parseFloat(m[2])) {
      report(out, `reversed edges ${m[0]}`);
    }
  }
  return out;
}

test("F2: no WGS84 literal survives in the shader code, and no smoothstep has reversed literal edges", () => {
  assert.deepEqual(shaderHygieneFindings(terrain), []);
});

test("F3 (mutant): a WGS84 literal and a reversed edge are DETECTED", () => {
  const dirty = `${terrain}\nlet a = smoothstep(0.78, 0.44, x) * 1.00673949674;`;
  assert.equal(shaderHygieneFindings(dirty).length, 2);
});

// ───────────────────── G. provenance wording (WL-07) ────────────────────────

/** Product and third-party-repository names the shader comments must not carry. */
function provenanceFindings(source) {
  return [...source.matchAll(/tidewater|subnautica|\bUE5\b|dgreenheck/gi)].map(
    (m) => m[0],
  );
}

test("G1: the shader comments cite the Fresnel equations and Cox and Munk, not a product or a repository", () => {
  assert.deepEqual(provenanceFindings(terrain), []);
  assert.match(terrain, /the Fresnel equations for unpolarized light/);
  assert.match(terrain, /Cox and Munk \(1954/);
});

test("G2 (mutant): a comment naming a third-party water shader is DETECTED", () => {
  assert.deepEqual(
    provenanceFindings(`${terrain}\n// matching tidewater WaterMaterial.js\n`),
    ["tidewater"],
  );
});

// ──────────── H. the globe material's water mask (MATERIAL_APPLY) ───────────
//
// MATERIAL_APPLY is a LO define, set whenever `globe.material` is, so its
// block is on the default hi word. At base (a999954e2b) every WebGPU globe
// material receives `waterMask = 0.0` (a TODO), where GlobeFS.glsl hands
// `materialInput.waterMask = mask`. The water work wired the sample in, but
// gated it on the tile flag (water mask AND `globe.showWaterEffect`) where
// GLSL gates on the mask alone, and the canonical demo
// (`globe-materials-water-mask-elevation-map`) turns `showWaterEffect` off. So
// this batch holds that change back (review B1, option b) and lands the base
// text; the parity fix is `NEW-WATER-GLOBE-MATERIAL-WATER-MASK`.
//
// The block is EXECUTED out of the MATERIAL_APPLY variant: a small statement
// walker runs its `var` / `let` / assignment / `if` lines through the mini
// evaluator, with the texture fetch bound to a function of the UV, and the
// value the material receives is read back. H2 pins the base value; H4 runs
// the held-back hunk on a copy to show the walker does see a live sample, and
// is the acceptance the parity fix starts from.

/** Run straight-line WGSL statements and `if` blocks against `env`, failing closed. */
function runStatements(text, env) {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) {
      i += 1;
    }
  };
  const matching = (open, close, from) => {
    let depth = 0;
    for (let j = from; j < text.length; j++) {
      if (text[j] === open) {
        depth += 1;
      } else if (text[j] === close) {
        depth -= 1;
        if (depth === 0) {
          return j;
        }
      }
    }
    throw new Error(`unbalanced ${open}`);
  };
  const expression = (source) => {
    const tokens = tokenize(source.replace(/,(\s*\))/g, "$1"));
    const { node, next } = parseExpression(tokens, 0);
    if (next !== tokens.length) {
      throw new Error(`unread tokens in: ${source}`);
    }
    return evaluate(node, env);
  };
  for (skipSpace(); i < text.length; skipSpace()) {
    if (/^if\s*\(/.test(text.slice(i))) {
      const open = text.indexOf("(", i);
      const close = matching("(", ")", open);
      const brace = text.indexOf("{", close);
      const end = matching("{", "}", brace);
      if (expression(text.slice(open + 1, close))) {
        runStatements(text.slice(brace + 1, end), env);
      }
      i = end + 1;
      continue;
    }
    let end = i;
    for (let depth = 0; end < text.length; end++) {
      if (text[end] === "(") {
        depth += 1;
      } else if (text[end] === ")") {
        depth -= 1;
      } else if (text[end] === ";" && depth === 0) {
        break;
      }
    }
    const statement = text.slice(i, end).trim();
    i = end + 1;
    let m;
    if ((m = /^var\s+(\w+)\s*:\s*[\w<>]+$/.exec(statement))) {
      env[m[1]] = {};
    } else if ((m = /^(?:let|var)\s+(\w+)\s*=([\s\S]+)$/.exec(statement))) {
      env[m[1]] = expression(m[2]);
    } else if ((m = /^(\w+)\.(\w+)\s*=([\s\S]+)$/.exec(statement))) {
      env[m[1]][m[2]] = expression(m[3]);
    } else if ((m = /^(\w+)\s*=([\s\S]+)$/.exec(statement))) {
      if (!(m[1] in env)) {
        throw new Error(`assignment to an undeclared ${m[1]}`);
      }
      env[m[1]] = expression(m[2]);
    } else {
      throw new Error(`statement outside the walker's subset: ${statement}`);
    }
  }
}

const MATERIAL_START = "var matInput: czm_MaterialInput;";
const MATERIAL_END = "let m = czm_getMaterial(matInput);";

/** The material block of the MATERIAL_APPLY variant, comments stripped. */
function materialBlock(source) {
  const variant = stripComments(
    preprocess(source, ShaderDefine.MATERIAL_APPLY, 0),
  );
  const start = variant.indexOf(MATERIAL_START);
  const end = variant.indexOf(MATERIAL_END);
  if (start < 0 || end < start) {
    throw new Error("the MATERIAL_APPLY variant has no material block");
  }
  return variant.slice(start, end);
}

/** The waterMask the material receives, executed out of the shader text. */
function materialWaterMask(source, { hasMask, geoUV, translation, scale }) {
  const fetches = [];
  const env = {
    __functions: {
      mat3x3: () => ({}),
      textureSampleLevel: (texture, sampler, uv, level) => {
        fetches.push({ texture, uv, level });
        return { r: uv.x + 10 * uv.y };
      },
    },
    waterMaskTexture: "waterMaskTexture",
    waterMaskSampler: "waterMaskSampler",
    geoUV: vec2(geoUV[0], geoUV[1]),
    normalEC: vec(0, 0, 1),
    input: {
      v_positionEC: vec(1, 2, 3),
      v_slope: 0.1,
      v_height: 12,
      v_aspect: 0.2,
    },
    tile: {
      flags: vec4(hasMask ? 1 : 0, 0, 0, 0),
      waterMaskTranslationAndScale: {
        xy: vec2(translation[0], translation[1]),
        zw: vec2(scale[0], scale[1]),
      },
    },
  };
  runStatements(materialBlock(source), env);
  return { waterMask: env.matInput.waterMask, fetches };
}

/** GlobeFS.glsl's law: translate-scale the tile coordinates, flip V, sample. */
function glslMaterialWaterMask({ geoUV, translation, scale }) {
  const u = geoUV[0] * scale[0] + translation[0];
  const v = 1 - (geoUV[1] * scale[1] + translation[1]);
  return u + 10 * v;
}

const MATERIAL_CASES = [
  { geoUV: [0.25, 0.75], translation: [0, 0], scale: [1, 1] },
  { geoUV: [0.5, 0.1], translation: [0.5, 0.25], scale: [0.5, 0.5] },
  { geoUV: [0.9, 0.6], translation: [0.125, 0.75], scale: [0.25, 0.25] },
];

const BASE_MATERIAL_LINE =
  "  matInput.waterMask = 0.0;  // TODO wire from water-mask texture path";

/** The water work's material sample, held back from this batch (banked in the lane). */
const HELD_MATERIAL_HUNK = [
  "  var matWaterMask = 0.0;",
  "  if (tile.flags.x > 0.5) {",
  "    let matWmTS = tile.waterMaskTranslationAndScale;",
  "    let matWaterUVUnflipped = geoUV * matWmTS.zw + matWmTS.xy;",
  "    let matWaterUV = vec2<f32>(matWaterUVUnflipped.x, 1.0 - matWaterUVUnflipped.y);",
  "    matWaterMask = textureSampleLevel(waterMaskTexture, waterMaskSampler, matWaterUV, 0.0).r;",
  "  }",
  "  matInput.waterMask = matWaterMask;",
].join("\n");

const withHeldHunk = (text) =>
  applyAnchors(text, [[BASE_MATERIAL_LINE, HELD_MATERIAL_HUNK]]);

/** Every case where the material is handed anything but the base 0 with no fetch. */
function baseMaterialFindings(source) {
  const findings = [];
  for (const c of MATERIAL_CASES) {
    for (const hasMask of [true, false]) {
      const { waterMask, fetches } = materialWaterMask(source, {
        ...c,
        hasMask,
      });
      if (waterMask !== 0 || fetches.length !== 0) {
        findings.push({ case: c, hasMask, waterMask, fetches: fetches.length });
      }
    }
  }
  return findings;
}

/** Every case where the material's waterMask is not the GLSL law's value. */
function glslLawFindings(source) {
  const findings = [];
  for (const c of MATERIAL_CASES) {
    const { waterMask, fetches } = materialWaterMask(source, {
      ...c,
      hasMask: true,
    });
    const expected = glslMaterialWaterMask(c);
    if (
      fetches.length !== 1 ||
      fetches[0].texture !== "waterMaskTexture" ||
      Math.abs(waterMask - expected) > 1e-12
    ) {
      findings.push({ case: c, waterMask, expected, fetches: fetches.length });
    }
  }
  return findings;
}

test("H1: GlobeFS.glsl hands the material the V-flipped water-mask sample (the law H4 holds the held-back hunk to)", () => {
  assert.match(
    glsl,
    /waterMaskTextureCoordinates = v_textureCoordinates\.xy \* waterMaskScale \+ waterMaskTranslation;\s*waterMaskTextureCoordinates\.y = 1\.0 - waterMaskTextureCoordinates\.y;/,
  );
  assert.match(
    glsl,
    /#ifdef HAS_WATER_MASK\s*materialInput\.waterMask = mask;/,
  );
});

test("H2: the MATERIAL_APPLY variant hands the material the base waterMask 0 and makes no water-mask fetch, with or without a mask", () => {
  assert.deepEqual(baseMaterialFindings(terrain), []);
});

test("H3: the material block exists only in the MATERIAL_APPLY variant", () => {
  assert.equal(defaultVariant(terrain).includes(MATERIAL_START), false);
  assert.equal(hiVariant(terrain, ENHANCED).includes(MATERIAL_START), false);
});

test("H4 (control): the held-back hunk, on a copy, hands the GLSL law's sample on a mask tile and 0 without a mask", () => {
  const held = withHeldHunk(terrain);
  assert.deepEqual(glslLawFindings(held), []);
  for (const c of MATERIAL_CASES) {
    const { waterMask, fetches } = materialWaterMask(held, {
      ...c,
      hasMask: false,
    });
    assert.equal(waterMask, 0);
    assert.equal(fetches.length, 0);
  }
});

test("H5 (mutant): the held-back hunk put back is DETECTED", () => {
  assertInertnessMutantTurnsRed(
    "material water mask held at base",
    terrain,
    withHeldHunk,
    (text) => assert.deepEqual(baseMaterialFindings(text), []),
  );
});

test("H6 (control): on the held-back hunk, a sample without the V flip is DETECTED by the GLSL law", () => {
  assertInertnessMutantTurnsRed(
    "material water mask V flip",
    withHeldHunk(terrain),
    [
      [
        "let matWaterUV = vec2<f32>(matWaterUVUnflipped.x, 1.0 - matWaterUVUnflipped.y);",
        "let matWaterUV = vec2<f32>(matWaterUVUnflipped.x, matWaterUVUnflipped.y);",
      ],
    ],
    (text) => assert.deepEqual(glslLawFindings(text), []),
  );
});

// ─────── I. the opt-in parity ocean is GlobeFS.glsl's (FND-1, FND-2, rounds 5-6) ──
//
// FND-2: at the 50 km coast camera the WebGPU ocean had no wave texture while
// WebGL had it (2a 14.6 % against a 10.7 % band): the shipped march's 150 m
// swell is mip-averaged flat at that footprint, where GlobeFS.glsl runs
// czm_getWaterNoise at 125000 and 825000 repeats. FND-1: the shipped coast band
// read the texel footprint, which stands in for fwidth(mask) only over a binary
// mask; over the ~12-texel distance-field ramp of the coastline and lake masks
// it spread the coast over the full ramp, 2.5 times WebGL's.
//
// Since water round 6 (seat ruling R-2026-10-23-S8) both laws are the opt-in
// WATER_PROVIDER_PARITY variant's, which the globe compiles only while a water
// classification provider feeds it; the default variant is the base shader
// (sections A and B, and globe-terrain-default-variant-identity). These cases
// execute the parity variant against the GLSL twin's constants. Round 6 also
// runs the classic waves on the unwrapped clock (I7, B1-wrap) and carries their
// derivatives through the pole-cap flip (I6, N1).

test("I1 (FND-2, N1): the parity variant's classic wave normal equals GlobeFS.glsl's computeWaterColor waves (executed, 7 points incl. the pole cap x 4 eyes x 4 clocks x 4 footprints)", () => {
  assert.equal(NOISE_TAPS.length, 4);
  assert.deepEqual(classicWaveMismatches(parityVariant(terrain)), []);
});

const CLASSIC_CALL =
  /let normalTangentSpace = classicOceanWaveNormal\(\s*positionMC,\s*uvDx \* spanNorm,\s*uvDy \* spanNorm,\s*length\(positionEC\),\s*waveSeconds,?\s*\);/;

test("I2 (FND-2): the parity ocean takes its normal and perturbation ratio from the classic law, as WebGL does; the default and enhanced variants never see it (variant text)", () => {
  const code = stripComments(parityVariant(terrain));
  assert.match(code, CLASSIC_CALL);
  assert.match(code, /waterNormal = enuToEye \* normalTangentSpace;/);
  assert.match(code, /tsPerturbationRatio = normalTangentSpace\.z;/);
  // The default variant keeps the shipped march; the enhanced variant keeps
  // the physical-wavelength march. Neither sees the classic helpers.
  const base = stripComments(defaultVariant(terrain));
  assert.doesNotMatch(base, /classicOceanWaveNormal|classicWaterNoise/);
  assert.match(base, /let waveN = sampleOceanWaveNormals\(/);
  const enhanced = stripComments(hiVariant(terrain, ENHANCED));
  assert.doesNotMatch(enhanced, /classicOceanWaveNormal|classicWaterNoise/);
  assert.match(enhanced, /waveN = sampleOceanWaveNormals\(/);
  assert.equal(
    hiVariant(terrain, ENHANCED | PARITY),
    hiVariant(terrain, ENHANCED),
    "the enhanced arm never reads the parity bit",
  );
});

test("I3 (mutants FND-2): a changed GLSL frequency, a changed noise divisor and the flat normal at the call site are each DETECTED", () => {
  const frequency = terrain.replace(
    "const CLASSIC_OCEAN_FREQUENCY_HIGH: f32 = 125000.0;",
    "const CLASSIC_OCEAN_FREQUENCY_HIGH: f32 = 130000.0;",
  );
  assert.notEqual(frequency, terrain, "frequency precondition");
  assert.notEqual(classicWaveMismatches(parityVariant(frequency)).length, 0);
  const divisor = terrain.replace(
    "let uv0 = fract(uv / 103.0 + time * vec2<f32>(1.0 / 17.0, 0.0));",
    "let uv0 = fract(uv / 107.0 + time * vec2<f32>(1.0 / 17.0, 0.0));",
  );
  assert.notEqual(divisor, terrain, "divisor precondition");
  assert.notEqual(classicWaveMismatches(parityVariant(divisor)).length, 0);
  const flat = terrain.replace(
    "    let normalTangentSpace = classicOceanWaveNormal(",
    "    let normalTangentSpace = vec3<f32>(0.0, 0.0, 1.0);\n    let unusedClassicNormal = classicOceanWaveNormal(",
  );
  assert.notEqual(flat, terrain, "flat-normal precondition");
  assert.doesNotMatch(stripComments(parityVariant(flat)), CLASSIC_CALL);
});

const POLAR_POINTS = WAVE_POINTS.filter(([, lat]) => lat >= 64);

test("I6 (mutants N1): the pole cap's flipped coordinates unused (O6), its derivatives not carried through the flip, and the blend slope dropped are each DETECTED", () => {
  assert.ok(POLAR_POINTS.some(([, lat]) => lat >= 72));
  assert.deepEqual(
    classicWaveMismatches(parityVariant(terrain), POLAR_POINTS),
    [],
  );
  const mutants = [
    [
      "let tc = mix(ellipsoidTc, flippedTc, poleBlend);",
      "let tc = ellipsoidTc;",
    ],
    [
      "let tcDx = mix(ellipsoidTcDx, vec2<f32>(flippedStepX.x, flippedStepX.y), poleBlend) +\n    (flippedTc - ellipsoidTc) * (poleBlendSlope * flippedStepX.z);\n  let tcDy = mix(ellipsoidTcDy, vec2<f32>(flippedStepY.x, flippedStepY.y), poleBlend) +\n    (flippedTc - ellipsoidTc) * (poleBlendSlope * flippedStepY.z);",
      "let tcDx = ellipsoidTcDx;\n  let tcDy = ellipsoidTcDy;",
    ],
    [
      "let poleBlendSlope = camera.morphTime * 6.0 * blendRamp * (1.0 - blendRamp) / 0.05;",
      "let poleBlendSlope = 0.0 * blendRamp;",
    ],
  ];
  for (const [from, to] of mutants) {
    assert.equal(
      terrain.split(from).length - 1,
      1,
      `mutation anchor: ${from.slice(0, 40)}`,
    );
    const mutant = terrain.replace(from, to);
    assert.notEqual(
      classicWaveMismatches(parityVariant(mutant), POLAR_POINTS).length,
      0,
      `the mutant ${to.slice(0, 40)} must be detected at the pole cap`,
    );
  }
});

const WAVE_CLOCK_BLOCK =
  /let waveSeconds = select\(camera\.oceanWaveSeconds, 0\.0, tile\.time > 1\.0e9\);/;

/** Disagreements past the tile clock's wrap: the call site's clock, then the law, against GLSL at unwrapped seconds. */
function wrapMismatches(text) {
  const variant = parityVariant(text);
  const clock = /let waveSeconds = [^;]+;/.exec(stripComments(variant));
  assert.ok(clock, "the parity call site must resolve its wave clock");
  const wave = classicWaveOf(variant);
  const out = [];
  const [lonDeg, latDeg] = WAVE_POINTS[0];
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const n = unitNormal(lon, lat);
  const positionMC = vec(n[0] * 6378137, n[1] * 6378137, n[2] * 6378137);
  // The tile clock is seconds x 0.15 x 60 wrapped at 16000 (WebGPUGlobeSurfaceTileUB),
  // so it wraps every 1777.8 s; the camera lane carries the seconds unwrapped.
  for (const seconds of [1777.0, 1778.5, 3600.25, 86400.5]) {
    const waveSeconds = blockValue(clock[0], "waveSeconds", {
      camera: { oceanWaveSeconds: seconds },
      tile: { time: (seconds * 0.15 * 60) % 16000 },
    });
    const got = laneValues(
      wave(positionMC, vec2(2e-7, 0), vec2(0, 1e-7), 25000, waveSeconds),
    );
    const want = glslWaveNormal(ellipsoidTc(n), 2e-7, 25000, seconds);
    const err = Math.max(...got.map((c, i) => Math.abs(c - want[i])));
    if (!(err < 1e-6)) {
      report(
        out,
        `t ${seconds}: [${got.map((c) => c.toFixed(5))}] vs GLSL [${want.map((c) => c.toFixed(5))}]`,
      );
    }
  }
  return out;
}

test("I7 (B1-wrap): past the tile clock's 1777.8 s wrap the parity sea is still GlobeFS.glsl's (the unwrapped camera clock), and the packer fills that lane", () => {
  assert.match(stripComments(parityVariant(terrain)), WAVE_CLOCK_BLOCK);
  assert.deepEqual(wrapMismatches(terrain), []);
  // The lane: the eye-cartographic vec3's alignment word, float 247, written
  // unwrapped after the eye tail.
  const struct = /struct CameraUniforms \{([\s\S]*?)\n\};/.exec(
    stripComments(terrain),
  );
  assert.ok(struct);
  const names = struct[1]
    .split("\n")
    .map((line) => /^\s*(\w+)\s*:/.exec(line)?.[1])
    .filter(Boolean);
  assert.equal(names[names.indexOf("eyeCartographic") + 1], "oceanWaveSeconds");
  const types = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
  );
  assert.match(types, /export const OCEAN_WAVE_SECONDS_OFFSET = 247;/);
  assert.match(types, /export const CAMERA_UNIFORM_FLOATS = 264;/);
  assert.match(cameraUb, /export const EYE_CARTOGRAPHIC_FLOATS = 20;/);
  assert.match(
    cameraUb,
    /writeEyeCartographicTail\(data, offset, uniformState\);\n\s*offset \+= EYE_CARTOGRAPHIC_FLOATS;\n(?:\s*\/\/[^\n]*\n)*\s*data\[OCEAN_WAVE_SECONDS_OFFSET\] = tileProvider\.oceanWaveSeconds \?\? 0\.0;/,
    "the packer writes the unwrapped seconds after the eye tail, which zeroes the lane",
  );
});

test("I7b (mutant B1-wrap): the wrapped tile clock at the call site is DETECTED past the wrap", () => {
  const mutant = terrain.replace(
    "let waveSeconds = select(camera.oceanWaveSeconds, 0.0, tile.time > 1.0e9);",
    "let waveSeconds = select(tile.time / 9.0, 0.0, tile.time > 1.0e9);",
  );
  assert.notEqual(mutant, terrain, "mutation precondition");
  assert.notEqual(wrapMismatches(mutant).length, 0);
});

/** The parity variant's `maskFwidth` at one texel neighbourhood, executed. */
function parityMaskFwidth(variantText, here, east, north) {
  const code = stripComments(variantText);
  const block =
    /let wmUvDx = [^;]+;\s*let wmUvDy = [^;]+;\s*let maskFwidth =[^;]+;/.exec(
      code,
    );
  assert.ok(block, "the parity coast band must compute maskFwidth");
  // A one-pixel step east lands at uv.x + 0.25, north at uv.y + 0.5 after the V
  // flip; the texture returns the mask at those two points and `here` elsewhere.
  const sample = (texture, sampler, uv) => {
    const [u, v] = laneValues(uv);
    const texel = (r) => Object.assign(vec4(r, 0, 0, 1), { r });
    if (Math.abs(u - 0.75) < 1e-9 && Math.abs(v - 0.5) < 1e-9) {
      return texel(east);
    }
    if (Math.abs(u - 0.5) < 1e-9 && Math.abs(v - 1.0) < 1e-9) {
      return texel(north);
    }
    return texel(here);
  };
  return blockValue(block[0], "maskFwidth", {
    geoUV_dx: vec2(0.25, 0),
    geoUV_dy: vec2(0, -0.5),
    wmTS: vec4(0, 0, 1, 1),
    waterUV: vec2(0.5, 0.5),
    waterMask: here,
    waterMaskTexture: {},
    waterMaskSampler: {},
    __functions: { mix, textureSampleLevel: sample },
  });
}

/** The band-input findings over one source: empty when it reads fwidth(mask). */
function fwidthFindings(text) {
  const out = [];
  const flat = parityMaskFwidth(parityVariant(text), 0.5, 0.5, 0.5);
  if (flat !== 0) {
    out.push(`a flat mask reads a band input of ${flat}`);
  }
  const step = parityMaskFwidth(parityVariant(text), 0.4, 0.5, 0.1);
  if (Math.abs(step - 0.4) > 1e-12) {
    out.push(`a 0.1 east / 0.3 north step reads ${step}, not 0.4`);
  }
  return out;
}

test("I4 (FND-1): the parity coast band reads the mask's own screen-space change (GlobeFS.glsl's fwidth(mask)), not the texel footprint; the default keeps the shipped band", () => {
  // A flat mask has no screen-space change, so the band sits on its 0.2 floor
  // whatever the texel footprint and a distance-field ramp is feathered as
  // WebGL feathers it; a step of 0.1 east and 0.3 north reads 0.4.
  assert.deepEqual(fwidthFindings(terrain), []);
  const code = stripComments(parityVariant(terrain));
  assert.match(
    code,
    /let coastBand = clamp\(maskFwidth \* 1\.5, 0\.2, 0\.5\);/,
  );
  assert.doesNotMatch(code, /let coastBand = clamp\(maskScreenGrad/);
  const base = stripComments(defaultVariant(terrain));
  assert.match(
    base,
    /let coastBand = clamp\(maskScreenGrad \* 1\.5, 0\.2, 0\.5\);/,
  );
  assert.doesNotMatch(base, /maskFwidth/);
  // The GLSL twin is the same law.
  assert.match(
    glsl,
    /float coastBand = clamp\(fwidth\(mask\) \* 1\.5, 0\.2, 0\.5\);/,
  );
});

test("I5 (mutant FND-1): the texel-footprint band input put back in the parity arm is DETECTED (executed)", () => {
  const mutant = terrain.replace(
    / {4}let maskFwidth =\n[^;]+;/,
    "    let maskFwidth = length(geoUV_dx * vec2<f32>(wmTS.z, wmTS.w) * 128.0) + length(geoUV_dy * vec2<f32>(wmTS.z, wmTS.w) * 128.0);",
  );
  assert.notEqual(mutant, terrain, "mutant precondition");
  assert.notEqual(fwidthFindings(mutant).length, 0);
});

// ─────── J. the parity taps read the texture as WebGL reads it (FND-2, round 7) ──
//
// Edge round 4 measured cell 2a at coast-50km at 2.2477 % (tolerance 16; bound
// 1.0 %) on the round-6 tree, while section I was green. Read from the banked
// captures (water-landing-r4/AFTER/water-cells/coast-50km, ON run 0 on both
// renderers): 20,714 of the 20,715 differing pixels lie inside the water, 13,707
// of them more than 32 px from the coast; the mean channel difference is
// -1.4 / -1.8 / -2.2 (no bias), the water's luma mean and spread agree
// (180.97 / 19.49 WebGL, 180.67 / 19.43 WebGPU) and the two waters correlate at
// 0.94 per pixel. The same waves, sampled differently. Section I could not see
// it: its map is a continuous function read at the tap's coordinate, so it
// holds the noise ARITHMETIC to the GLSL twin and says nothing about which texels
// a tap reads.
//
// The texels differ by construction. WebGL builds `u_oceanNormalMap` as
// `new Texture({ context, source: image })` (Globe.js): one level, and the
// default Sampler (CLAMP_TO_EDGE, LINEAR, maxAnisotropy 1), so every
// czm_getWaterNoise tap is a bilinear read of level 0. The WebGPU copy carries a
// full mip chain (uploadImageSource) and the shared repeat sampler with
// maxAnisotropy 8, and the round-6 taps were `textureSampleGrad` with the
// coordinates' derivatives, so at the 50 km coast the low layer's first two
// taps read mip levels 1-2. These cases execute the variant's taps over a
// 256 x 256 texel grid with a box-filtered mip chain, under a model of each
// backend's sampler built from the configuration the source states (J1), and
// hold them to the GLSL read (J2). The anisotropic sampler is modelled as
// isotropic; that only moves WHICH level above 0 a derivative-driven tap reads.
// The pixel effect is a capture's to measure (EDGE_LEG_WATER.md cell 2a).

const J_SIZE = 256;

/** A deterministic rgba8 texel: a hash, so neighbouring texels and levels differ. */
function jTexel(x, y) {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255, 255].map((c) => c / 255);
}

/** Level 0 and its box-filtered chain down to 1 x 1, as uploadImageSource allocates. */
const J_LEVELS = (() => {
  const levels = [];
  let size = J_SIZE;
  let data = new Float64Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      data.set(jTexel(x, y), (y * size + x) * 4);
    }
  }
  levels.push({ size, data });
  while (size > 1) {
    const half = size / 2;
    const next = new Float64Array(half * half * 4);
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const top = (2 * y * size + 2 * x) * 4;
        const bottom = top + size * 4;
        for (let c = 0; c < 4; c++) {
          next[(y * half + x) * 4 + c] =
            (data[top + c] +
              data[top + 4 + c] +
              data[bottom + c] +
              data[bottom + 4 + c]) /
            4;
        }
      }
    }
    size = half;
    data = next;
    levels.push({ size, data });
  }
  return levels;
})();

/** A bilinear read of one level, with CLAMP_TO_EDGE ("clamp") or "repeat" addressing. */
function jBilinear(level, u, v, wrap) {
  const { size, data } = J_LEVELS[level];
  const address = (i) =>
    wrap === "repeat" ? ((i % size) + size) % size : clamp(i, 0, size - 1);
  const x = u * size - 0.5;
  const y = v * size - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const out = [0, 0, 0, 0];
  for (const [dx, dy, w] of [
    [0, 0, (1 - fx) * (1 - fy)],
    [1, 0, fx * (1 - fy)],
    [0, 1, (1 - fx) * fy],
    [1, 1, fx * fy],
  ]) {
    const at = (address(y0 + dy) * size + address(x0 + dx)) * 4;
    for (let c = 0; c < 4; c++) {
      out[c] += w * data[at + c];
    }
  }
  return out;
}

/** A linear-mip read with repeat addressing at level of detail `lambda`. */
function jTrilinear(lambda, u, v) {
  const top = J_LEVELS.length - 1;
  const l = clamp(lambda, 0, top);
  const l0 = Math.floor(l);
  const l1 = Math.min(l0 + 1, top);
  const f = l - l0;
  const a = jBilinear(l0, u, v, "repeat");
  const b = jBilinear(l1, u, v, "repeat");
  return a.map((c, i) => mix(c, b[i], f));
}

/** GlobeFS.glsl czm_getWaterNoise(u_oceanNormalMap, uv, time, 0.0), read as WebGL reads it. */
function jGlslWaterNoise(uv, time) {
  const sum = [0, 0, 0, 0];
  for (const tap of NOISE_TAPS) {
    const u = fract(uv[0] / tap.divisor[0] + time * tap.dir[0] + tap.offset);
    const v = fract(uv[1] / tap.divisor[1] + time * tap.dir[1] + tap.offset);
    jBilinear(0, u, v, "clamp").forEach((c, i) => {
      sum[i] += c;
    });
  }
  return sum.map((c) => (c / 4 - 0.5) * 2);
}

/**
 * The variant's `classicWaterNoise`, executable over the texel grid under the
 * WebGPU sampler model. Returns `(uv, time, uvDx, uvDy) => rgba`; the
 * derivatives reach the function only if its signature still takes them.
 */
function jVariantNoiseOf(variantText) {
  const code = stripComments(variantText).replace(/,(\s*\))/g, "$1");
  const injected = {
    fract: lift(fract),
    // The level argument selects the mip whose size is reported, as WGSL's
    // textureDimensions(t, level) does, so a half-texel taken from level 1
    // is a different clamp from one taken from level 0 (Orodruin pass 7, N1).
    textureDimensions: (map, level = 0) => {
      const { size } = J_LEVELS[Number(level)];
      return vec2(size, size);
    },
    textureSampleLevel: (map, sampler, uv, level) =>
      vec4(...jTrilinear(level, ...laneValues(uv))),
    textureSampleGrad: (map, sampler, uv, dx, dy) => {
      const footprint =
        Math.max(Math.hypot(...laneValues(dx)), Math.hypot(...laneValues(dy))) *
        J_SIZE;
      return vec4(
        ...jTrilinear(
          footprint > 0 ? Math.log2(footprint) : 0,
          ...laneValues(uv),
        ),
      );
    },
  };
  const common = {
    ...readConstants(code),
    oceanNormalMap: {},
    oceanNormalSampler: {},
  };
  const functions = { ...injected };
  if (/\bfn classicWaterNoiseTap\(/.test(code)) {
    functions.classicWaterNoiseTap = compileFunction(
      code,
      "classicWaterNoiseTap",
      { ...common, __functions: injected },
    );
  }
  const noise = compileFunction(code, "classicWaterNoise", {
    ...common,
    __functions: functions,
  });
  const takesDerivatives = /\bfn classicWaterNoise\(uv: vec2<f32>, uvDx:/.test(
    code,
  );
  return (uv, time, uvDx, uvDy) =>
    laneValues(
      takesDerivatives
        ? noise(vec2(...uv), vec2(...uvDx), vec2(...uvDy), time)
        : noise(vec2(...uv), time),
    );
}

// The coast-50km camera: 50 km eye over (-122.6, 37.7), 1280 px across a 60
// degree field of view, so about 45 m per pixel at nadir (more off nadir). In
// the ellipsoid texture coordinates that is 45 / (2 pi R cos 37.7) across and
// 45 / (pi R) along a meridian; the low layer multiplies both by 825000.
const J_TC = [(-122.6 + 180) / 360, (37.7 + 90) / 180];
const J_METRES_PER_PIXEL = (2 * Math.tan(Math.PI / 6) * 50000) / 1280;
const J_TC_DX = [
  J_METRES_PER_PIXEL /
    (2 * Math.PI * 6378137 * Math.cos((37.7 * Math.PI) / 180)),
  0,
];
const J_TC_DY = [0, J_METRES_PER_PIXEL / (Math.PI * 6378137)];

/** Disagreements between the variant's taps and the GLSL read, low and high layers. */
function jTapFindings(variantText) {
  const noise = jVariantNoiseOf(variantText);
  const out = [];
  const layers = [
    ["low", 825000, 0.004],
    ["high", 125000, 0.008],
  ];
  // Two texel-edge points: tap 0 lands within half a texel of an edge, where
  // CLAMP_TO_EDGE and repeat read different texels.
  const edge = (k, f) => 103 * (k + f);
  const points = [
    ["coast", (freq) => [J_TC[0] * freq, J_TC[1] * freq]],
    [
      "coast+1px",
      (freq) => [(J_TC[0] + J_TC_DX[0]) * freq, (J_TC[1] + J_TC_DY[1]) * freq],
    ],
    [
      "edge-high",
      () => [edge(1000, 1 - 0.3 / J_SIZE), edge(2000, 1 - 0.2 / J_SIZE)],
    ],
    ["edge-low", () => [edge(1000, 0.3 / J_SIZE), edge(2000, 0.2 / J_SIZE)]],
  ];
  for (const [layer, freq, speed] of layers) {
    for (const [name, at] of points) {
      for (const seconds of [0, 7.25, 600]) {
        const time = name.startsWith("edge") ? 0 : seconds * 60 * speed;
        const uv = at(freq);
        const got = noise(
          uv,
          time,
          [J_TC_DX[0] * freq, J_TC_DX[1] * freq],
          [J_TC_DY[0] * freq, J_TC_DY[1] * freq],
        );
        const want = jGlslWaterNoise(uv, time);
        const err = Math.max(...got.map((c, i) => Math.abs(c - want[i])));
        if (!(err < 1e-6)) {
          report(
            out,
            `${layer} ${name} t ${seconds}: [${got.map((c) => c.toFixed(4))}] vs GLSL [${want.map((c) => c.toFixed(4))}]`,
          );
        }
      }
    }
  }
  return out;
}

test("J1 (FND-2, round 7): the two backends' ocean normal textures differ as the parity taps assume (WebGL: one level, CLAMP_TO_EDGE, LINEAR; WebGPU: a mip chain, repeat, linear mip)", () => {
  const globe = read("packages/engine/Source/Scene/Globe.js");
  assert.match(
    globe,
    /that\._oceanNormalMap = new Texture\(\{\s*context: frameState\.context,\s*source: image,\s*\}\);/,
    "WebGL builds the ocean normal map with no sampler of its own",
  );
  assert.doesNotMatch(globe, /_oceanNormalMap\.generateMipmap/);
  assert.match(
    read("packages/engine/Source/Renderer/Texture.js"),
    /sampler = new Sampler\(\),/,
  );
  const sampler = read("packages/engine/Source/Renderer/Sampler.js");
  for (const fragment of [
    "wrapS = TextureWrap.CLAMP_TO_EDGE,",
    "wrapT = TextureWrap.CLAMP_TO_EDGE,",
    "minificationFilter = TextureMinificationFilter.LINEAR,",
    "maximumAnisotropy = 1.0,",
  ]) {
    assert.ok(sampler.includes(fragment), `Sampler default ${fragment}`);
  }
  const layouts = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts",
  );
  const ocean = /label: "Globe ocean normal sampler",[^}]*\}/.exec(layouts);
  assert.ok(ocean, "the WebGPU ocean normal sampler");
  assert.match(ocean[0], /addressModeU: "repeat"/);
  assert.match(ocean[0], /mipmapFilter: "linear"/);
  assert.match(
    read(
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTextures.ts",
    ),
    /const mipLevelCount = mipLevelCountFor\(width, height\);/,
  );
  // The models below are those configurations.
  assert.equal(J_LEVELS.length, 9);
  assert.equal(J_LEVELS[8].size, 1);
});

test("J2 (FND-2, round 7): the parity taps read level 0, bilinear, clamped at the edge, as GlobeFS.glsl's taps do (executed over a texel grid with a mip chain, at the coast-50km footprint and at texel edges)", () => {
  assert.deepEqual(jTapFindings(parityVariant(terrain)), []);
  // The fix lives only in the parity variant.
  assert.doesNotMatch(
    stripComments(defaultVariant(terrain)),
    /classicWaterNoiseTap/,
  );
  assert.doesNotMatch(
    stripComments(hiVariant(terrain, ENHANCED)),
    /classicWaterNoiseTap/,
  );
});

const J_ROUND6_TAPS = [
  [
    "fn classicWaterNoise(uv: vec2<f32>, time: f32) -> vec4<f32> {",
    "fn classicWaterNoise(uv: vec2<f32>, uvDx: vec2<f32>, uvDy: vec2<f32>, time: f32) -> vec4<f32> {",
  ],
  [
    "    classicWaterNoiseTap(uv0) +\n    classicWaterNoiseTap(uv1) +\n    classicWaterNoiseTap(uv2) +\n    classicWaterNoiseTap(uv3);",
    "    textureSampleGrad(oceanNormalMap, oceanNormalSampler, uv0, uvDx / 103.0, uvDy / 103.0) +\n    textureSampleGrad(oceanNormalMap, oceanNormalSampler, uv1, uvDx / 107.0, uvDy / 107.0) +\n    textureSampleGrad(oceanNormalMap, oceanNormalSampler, uv2, uvDx / d2, uvDy / d2) +\n    textureSampleGrad(oceanNormalMap, oceanNormalSampler, uv3, uvDx / d3, uvDy / d3);",
  ],
];

test("J3 (mutant FND-2): the round-6 derivative-driven taps put back are DETECTED at the coast-50km footprint", () => {
  assertInertnessMutantTurnsRed(
    "parity taps read level 0",
    terrain,
    J_ROUND6_TAPS,
    (text) => assert.deepEqual(jTapFindings(parityVariant(text)), []),
  );
});

test("J4 (mutants FND-2): a tap without the edge clamp, a tap at level 1, and a half texel sized from level 1 are each DETECTED", () => {
  const sample =
    "  return textureSampleLevel(oceanNormalMap, oceanNormalSampler, clamped, 0.0);";
  assertInertnessMutantTurnsRed(
    "parity taps clamp at the edge",
    terrain,
    [
      [
        sample,
        "  return textureSampleLevel(oceanNormalMap, oceanNormalSampler, uv + 0.0 * clamped, 0.0);",
      ],
    ],
    (text) => assert.deepEqual(jTapFindings(parityVariant(text)), []),
  );
  assertInertnessMutantTurnsRed(
    "parity taps read level 0 (level)",
    terrain,
    [
      [
        sample,
        "  return textureSampleLevel(oceanNormalMap, oceanNormalSampler, clamped, 1.0);",
      ],
    ],
    (text) => assert.deepEqual(jTapFindings(parityVariant(text)), []),
  );
  // Round 8 (Orodruin pass 7, N1): the half texel taken from level 1's size.
  assertInertnessMutantTurnsRed(
    "parity taps clamp half a level-0 texel inside the edge",
    terrain,
    [
      [
        "  let halfTexel = vec2<f32>(0.5) / vec2<f32>(textureDimensions(oceanNormalMap, 0));",
        "  let halfTexel = vec2<f32>(0.5) / vec2<f32>(textureDimensions(oceanNormalMap, 1));",
      ],
    ],
    (text) => assert.deepEqual(jTapFindings(parityVariant(text)), []),
  );
});
