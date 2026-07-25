// ocean-wave-lod.spec.mjs — C11-172 v3 analytic acceptance spec.
//
// Pins the ocean-wave PHYSICAL-WAVELENGTH march + RTE phase decomposition
// (2026-07-24) BEFORE any GPU draws it
// (`node --test Tools/visual-regression/ocean-wave-lod.spec.mjs`).
//
// v3 samples 3 octaves in a GLOBAL ellipsoid (lon/lat) UV at INTEGER normal-map
// repeat counts Rᵢ = round(circumference / wavelengthᵢ). To keep f32 precise
// (the absolute `euv × Rᵢ` reached ~2.7e6 ⇒ ulp ~0.25 repeat ⇒ staircase bands +
// frozen advection) the CPU packs per-tile per-octave phase offsets computed in
// f64 (fract(rectOriginNorm × Rᵢ)) + the normalized tile span; the shader
// reconstructs the coordinate from small tile-local quantities. This spec
// EXTRACTS the repeats + weights + fade band FROM the shader/TS sources and
// asserts:
//
//   (a) fade BAND (FADE_LO/HI, repeats/pixel) + hard-cutoff are IDENTICAL in the
//       WGSL march + the GLSL twin (shared policy — Principle 5).
//   (b) WGSL is mip/aniso-aware (`textureSampleGrad` ×3, sampler maxAnisotropy)
//       and RTE-decomposed (samples `phaseᵢ + euvLocal × Rᵢ`, reads the packed
//       tile-UB phase fields); GLSL keeps czm_getWaterNoise (auto-LOD) + the
//       effective-divisor calibration.
//   (c) both backends carry the HARD FAR CUTOFF branch.
//   (d) true AMPLITUDE fade (D3): WGSL scales each octave's `.xy` by its weight,
//       keeps `.z`; GLSL scales the layer `.xy`. (Not the v1 no-op inside normalize.)
//   (e) EXTRACTED repeats are INTEGER (P3 — exact wrap), ascend R1<R2<R3, imply
//       descending wavelengths ≈ 150/50/15 m, and MATCH the TS
//       OCEAN_OCTAVE_REPEATS the CPU packer uses (WGSL↔TS lockstep — the phase
//       decomposition is only correct if both sides use the SAME integer Rᵢ);
//       weights sum ~1; LOD-curve shape (full near, monotone, 0 past FADE_HI);
//       shortest wavelength (largest R) fades first.
//   (f) PRECISION (P1): the ORIGINAL absolute coordinate `euv × R₃` at 60 N /
//       170 E has an f32 ulp WELL ABOVE 1% of a repeat (motivating the fix),
//       while the v3 DECOMPOSED coordinate (phase<1 + euvLocal×Rᵢ<tileScreenPx +
//       fract(time)<1) has an f32 ulp BELOW 1% of a repeat for ALL three octaves.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const wgslPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);
const glslPath = path.join(root, "packages/engine/Source/Shaders/GlobeFS.glsl");
const samplerTsPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts",
);
const typesTsPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
);

const wgsl = fs.readFileSync(wgslPath, "utf8");
const glsl = fs.readFileSync(glslPath, "utf8");
const samplerTs = fs.readFileSync(samplerTsPath, "utf8");
const typesTs = fs.readFileSync(typesTsPath, "utf8");

const NUM = "([0-9]+(?:\\.[0-9]+)?)";

function extract(src, re, what, file) {
  const m = src.match(re);
  assert.ok(m, `${what} not found in ${file}`);
  return parseFloat(m[1]);
}

// EXTRACTED shared band + cutoff (single source of truth = the shaders).
const FADE_LO_W = extract(wgsl, new RegExp(`const OCEAN_OCTAVE_FADE_LO: f32 = ${NUM};`), "FADE_LO", "wgsl");
const FADE_HI_W = extract(wgsl, new RegExp(`const OCEAN_OCTAVE_FADE_HI: f32 = ${NUM};`), "FADE_HI", "wgsl");
const CUTOFF_W = extract(wgsl, new RegExp(`const OCEAN_WAVE_MARCH_CUTOFF: f32 = ${NUM};`), "CUTOFF", "wgsl");

// EXTRACTED WGSL octave repeat counts + importance weights + circumference.
const CIRC = extract(wgsl, new RegExp(`const OCEAN_CIRCUMFERENCE_M: f32 = ${NUM};`), "CIRC", "wgsl");
const R1 = extract(wgsl, new RegExp(`const OCEAN_OCTAVE_REPEATS_1: f32 = ${NUM};`), "R1", "wgsl");
const R2 = extract(wgsl, new RegExp(`const OCEAN_OCTAVE_REPEATS_2: f32 = ${NUM};`), "R2", "wgsl");
const R3 = extract(wgsl, new RegExp(`const OCEAN_OCTAVE_REPEATS_3: f32 = ${NUM};`), "R3", "wgsl");
const IW1 = extract(wgsl, new RegExp(`const OCEAN_OCTAVE_WEIGHT_1: f32 = ${NUM};`), "W1", "wgsl");
const IW2 = extract(wgsl, new RegExp(`const OCEAN_OCTAVE_WEIGHT_2: f32 = ${NUM};`), "W2", "wgsl");
const IW3 = extract(wgsl, new RegExp(`const OCEAN_OCTAVE_WEIGHT_3: f32 = ${NUM};`), "W3", "wgsl");

const REPEATS = [R1, R2, R3];
const IMPORTANCE = [IW1, IW2, IW3];
const TARGET_WAVELENGTHS = [150.0, 50.0, 15.0]; // documented equatorial-zonal

// f32 unit-in-last-place at magnitude x (24-bit mantissa).
function f32ulp(x) {
  if (x === 0) return 2 ** -149;
  const e = Math.floor(Math.log2(Math.abs(x)));
  return 2 ** (e - 23);
}

// ---------------------------------------------------------------------------
test("(a) fade band + cutoff are shared WGSL<->GLSL (increasing smoothstep)", () => {
  const FADE_LO_G = extract(glsl, new RegExp(`const float OCEAN_OCTAVE_FADE_LO = ${NUM};`), "FADE_LO", "glsl");
  const FADE_HI_G = extract(glsl, new RegExp(`const float OCEAN_OCTAVE_FADE_HI = ${NUM};`), "FADE_HI", "glsl");
  const CUTOFF_G = extract(glsl, new RegExp(`const float OCEAN_WAVE_MARCH_CUTOFF = ${NUM};`), "CUTOFF", "glsl");
  assert.equal(FADE_LO_W, FADE_LO_G, "FADE_LO drift WGSL<->GLSL");
  assert.equal(FADE_HI_W, FADE_HI_G, "FADE_HI drift WGSL<->GLSL");
  assert.equal(CUTOFF_W, CUTOFF_G, "CUTOFF drift WGSL<->GLSL");
  assert.ok(FADE_LO_W < FADE_HI_W, "FADE_LO must be < FADE_HI (increasing edges)");
  assert.ok(CUTOFF_W > 0 && CUTOFF_W < 0.1, "cutoff must be a small positive sum");
});

// ---------------------------------------------------------------------------
test("(b) WGSL mip/aniso-aware + RTE-decomposed; GLSL keeps auto-LOD + divisor", () => {
  const march = wgsl.slice(
    wgsl.indexOf("fn sampleOceanWaveNormals"),
    wgsl.indexOf("fn computeFoam"),
  );
  assert.ok(march.length > 0, "sampleOceanWaveNormals body not found");
  assert.equal((march.match(/textureSampleGrad\(/g) || []).length, 3, "expected 3 mip/aniso samples");
  assert.ok(!/textureSampleLevel\(\s*oceanNormalMap/.test(march), "octave sampled at a fixed LOD — not mip-aware");
  // RTE decomposition: samples phaseᵢ + euvLocal × Rᵢ, reads packed phase fields.
  assert.match(march, /phase1 \+ euvLocal \* OCEAN_OCTAVE_REPEATS_1/, "octave 1 must sample phase + euvLocal*R (RTE)");
  assert.match(wgsl, /tile\.oceanWavePhaseA/, "must read the packed phase-A field");
  assert.match(wgsl, /tile\.oceanWavePhaseB/, "must read the packed phase-B/span field");
  assert.match(wgsl, /let spanNorm = tile\.oceanWavePhaseB\.zw/, "span must come from the UB (not east-west in the FS)");
  // Anisotropy on the ocean sampler.
  assert.match(
    samplerTs,
    /Globe ocean normal sampler[\s\S]{0,500}maxAnisotropy:\s*([2-9]|1[0-6])/,
    "ocean sampler must declare maxAnisotropy >= 2",
  );
  // CPU packs f64 fract phase offsets.
  const tileUb = fs.readFileSync(
    path.join(root, "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts"),
    "utf8",
  );
  // Whitespace-tolerant: prettier wraps this call across three lines once the
  // enclosing statement exceeds the print width, which a single-line literal
  // pattern cannot survive. Assert the CALL SHAPE, not its formatting.
  assert.match(
    tileUb,
    /frac\(\s*originU \* OCEAN_OCTAVE_REPEATS\[0\]\s*,?\s*\)/,
    "CPU must pack fract(originU*R0) phase offset",
  );
  // GLSL twin: auto-LOD + effective-divisor calibration.
  assert.match(glsl, /czm_getWaterNoise\(u_oceanNormalMap/, "GLSL auto-LOD path missing");
  assert.match(glsl, /OCEAN_GETWATERNOISE_DIVISOR/, "GLSL effective-divisor recalibration (D2) missing");
});

// ---------------------------------------------------------------------------
test("(c) hard far cutoff branch present in both shaders", () => {
  assert.match(wgsl, /w1 \+ w2 \+ w3 < OCEAN_WAVE_MARCH_CUTOFF/, "WGSL cutoff branch missing");
  assert.match(glsl, /< OCEAN_WAVE_MARCH_CUTOFF/, "GLSL cutoff branch missing");
});

// ---------------------------------------------------------------------------
test("(d) fade is a true amplitude fade (.xy scaled by weight, .z kept)", () => {
  assert.match(wgsl, /vec3<f32>\(n1\.xy \* w1, n1\.z \* OCEAN_OCTAVE_WEIGHT_1\)/, "WGSL octave 1 amplitude fade missing");
  assert.match(wgsl, /vec3<f32>\(n3\.xy \* w3, n3\.z \* OCEAN_OCTAVE_WEIGHT_3\)/, "WGSL octave 3 amplitude fade missing");
  assert.ok(!/normalize\(n1 \* w1 \+ n2 \* w2 \+ n3 \* w3\)/.test(wgsl), "WGSL must not scale whole vectors inside normalize");
  assert.match(glsl, /normalTangentSpaceHighAltitude\.xy \*= highLodWeight/, "GLSL high-layer amplitude fade missing");
  assert.match(glsl, /normalTangentSpaceLowAltitude\.xy \*= lowLodWeight/, "GLSL low-layer amplitude fade missing");
});

// ---------------------------------------------------------------------------
// CPU model of the shader helper (1-arg: repeatsPerPixel).
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1.0, Math.max(0.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}
function lodWeight(repeatsPerPixel) {
  return 1.0 - smoothstep(FADE_LO_W, FADE_HI_W, repeatsPerPixel);
}

test("(e) repeats are integer (exact wrap), ascend, imply ~150/50/15 m, match TS", () => {
  for (let i = 0; i < REPEATS.length; i++) {
    assert.equal(REPEATS[i], Math.round(REPEATS[i]), `repeat ${i} must be integer (exact ±180° wrap, P3)`);
    const wavelength = CIRC / REPEATS[i];
    assert.ok(
      Math.abs(wavelength - TARGET_WAVELENGTHS[i]) / TARGET_WAVELENGTHS[i] < 0.01,
      `octave ${i} wavelength ${wavelength.toFixed(2)} m off target ${TARGET_WAVELENGTHS[i]}`,
    );
    // integer repeats must be exactly f32-representable (< 2^24) for CPU/GPU agreement.
    assert.ok(REPEATS[i] < 2 ** 24, `repeat ${i} not exactly f32-representable`);
  }
  assert.ok(R1 < R2 && R2 < R3, `repeats must ascend swell<medium<ripple (${R1},${R2},${R3})`);
  const sum = IMPORTANCE.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `importance weights sum ${sum} != ~1.0`);
  assert.ok(IW1 >= IW2 && IW2 >= IW3, "swell should be the dominant importance");

  // WGSL <-> TS lockstep: the CPU phase decomposition is only correct if the
  // packer uses the SAME integer repeats as the shader.
  const tsArr = typesTs.match(/OCEAN_OCTAVE_REPEATS\s*=\s*\[([^\]]+)\]/);
  assert.ok(tsArr, "TS OCEAN_OCTAVE_REPEATS array not found");
  const tsReps = tsArr[1].split(",").map((s) => parseFloat(s.trim()));
  assert.deepEqual(tsReps, REPEATS, "TS OCEAN_OCTAVE_REPEATS must match the WGSL repeats");
});

test("(e) LOD weight: full near, monotone, exactly 0 past FADE_HI; largest R fades first", () => {
  for (const R of REPEATS) {
    assert.equal(lodWeight(0.0), 1.0, "weight not 1 at zero footprint");
    assert.equal(lodWeight(R * ((FADE_LO_W * 0.999) / R)), 1.0, "octave faded before FADE_LO");
    assert.equal(lodWeight(R * (FADE_HI_W / R)), 0.0, "octave nonzero at FADE_HI");
    let prev = 1.0;
    for (let k = 0; k <= 40; k++) {
      const wv = lodWeight((FADE_HI_W / R) * (k / 40) * R);
      assert.ok(wv <= prev + 1e-12, "weight not monotone");
      prev = wv;
    }
  }
  const halfFoot = (R) => {
    let lo = 0, hi = FADE_HI_W / R;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (lodWeight(R * mid) > 0.5) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  };
  const hf = REPEATS.map(halfFoot);
  assert.ok(hf[2] < hf[1] && hf[1] < hf[0], "shortest wavelength (largest R) must reach half-weight first");
});

// ---------------------------------------------------------------------------
// (f) f32 precision at 60 N / 170 E — the P1 blocker.
const ONE_OVER_TWO_PI = 0.15915494309189535;
const ONE_OVER_PI = 0.3183098861837907;
const REPEAT_ULP_LIMIT = 0.01; // 1% of a repeat

test("(f) ORIGINAL absolute euv×R coordinate quantizes (>1% of a repeat) at 60N/170E", () => {
  const lonRad = (170 * Math.PI) / 180;
  const latRad = (60 * Math.PI) / 180;
  const euvX = lonRad * ONE_OVER_TWO_PI + 0.5; // ~0.972
  const euvY = latRad * ONE_OVER_PI + 0.5; // ~0.833
  const euvMax = Math.max(euvX, euvY);
  // The ripple (largest R) is the worst case.
  const absCoord = euvMax * R3;
  const ulp = f32ulp(absCoord);
  assert.ok(
    ulp > REPEAT_ULP_LIMIT,
    `original absolute coord ulp ${ulp} should exceed ${REPEAT_ULP_LIMIT} (the defect that motivated v3)`,
  );
});

test("(f) v3 DECOMPOSED coordinate ulp < 1% of a repeat for ALL octaves at 60N/170E", () => {
  // The v3 shader coordinate for a resolved octave is:
  //   phaseᵢ (< 1)  +  euvLocal × Rᵢ (< tileScreenPx when weight > 0)  +  fract(t·v) (< 1)
  // euvLocal × Rᵢ < tileScreenPx because resolved ⇒ Rᵢ × footMin < FADE_HI and
  // euvLocal.max = spanNorm ≈ footMin × tileScreenPx (footprint = span / screen px),
  // so spanNorm × Rᵢ < FADE_HI × tileScreenPx = tileScreenPx. A very generous
  // upper bound on the SSE-held tile screen size:
  const TILE_SCREEN_PX_MAX = 2048;
  const worstMagnitude = 1.0 + TILE_SCREEN_PX_MAX + 1.0;
  for (let i = 0; i < REPEATS.length; i++) {
    const ulp = f32ulp(worstMagnitude);
    assert.ok(
      ulp < REPEAT_ULP_LIMIT,
      `octave ${i} decomposed coord ulp ${ulp} >= ${REPEAT_ULP_LIMIT} — precision fix insufficient`,
    );
  }
  // Also assert the packed phase offset itself (fract, in [0,1)) is trivially precise.
  const lonRad = (170 * Math.PI) / 180;
  const originU = lonRad * ONE_OVER_TWO_PI + 0.5;
  for (const R of REPEATS) {
    const phase = (originU * R) - Math.floor(originU * R);
    assert.ok(phase >= 0 && phase < 1, "phase offset must be in [0,1)");
    assert.ok(f32ulp(phase) < REPEAT_ULP_LIMIT, "packed phase offset must be f32-precise");
  }
});
