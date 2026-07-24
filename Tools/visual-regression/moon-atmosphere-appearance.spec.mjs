// moon-atmosphere-appearance.spec.mjs — C12 moon wave: pins the C12-30
// in-scattering sky-wash, the C12-20 Lommel-Seeliger reflectance, and the
// C12-23 opposition surge on BOTH backends, plus the CPU integrator's
// numeric contracts.
//
// The composite under test (both backends, character-consistent):
//     disc = discColor × extinction + inscatter
// with discColor from Lommel-Seeliger 2·μ0/(μ0+μ+ε) × oppositionSurge when
// atmosphericConditions.lighting.enableLunarBRDF / enableOppositionSurge
// are on (defaults ON).
//
// These tests fail if either backend loses a term the other keeps (the
// C11-176/C12 exit-gate class: a default-ON celestial multiplier must
// never be single-backend), if the C11-176b scaffolding contract is
// broken, if the WGSL stops validating under naga, or if the CPU
// integrator's identity/physics contracts drift.
//
// Run: node --test Tools/visual-regression/moon-atmosphere-appearance.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const wgslPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
);
const glslPath = path.join(root, "packages/engine/Source/Shaders/EllipsoidFS.glsl");
const primitivePath = path.join(
  root,
  "packages/engine/Source/Scene/EllipsoidPrimitive.js",
);
const sceneMoonPath = path.join(root, "packages/engine/Source/Scene/Moon.js");
const envRendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
);
const conditionsPath = path.join(
  root,
  "packages/engine/Source/Scene/AtmosphericConditions.js",
);

const wgsl = fs.readFileSync(wgslPath, "utf8");
const glsl = fs.readFileSync(glslPath, "utf8");
const primitive = fs.readFileSync(primitivePath, "utf8");
const sceneMoon = fs.readFileSync(sceneMoonPath, "utf8");
const envRenderer = fs.readFileSync(envRendererPath, "utf8");
const conditions = fs.readFileSync(conditionsPath, "utf8");

// WGSL uses only `//` comments — strip them so pins run against code.
const stripLineComments = (src) =>
  src
    .split("\n")
    .map((line) => {
      const slash = line.indexOf("//");
      return slash >= 0 ? line.slice(0, slash) : line;
    })
    .join("\n");

const wgslCode = stripLineComments(wgsl);

// ── C12-20 — Lommel-Seeliger on both backends ───────────────────────────────

test("WGSL: Lommel-Seeliger branch selected by the runtime lunarBRDF uniform", () => {
  assert.match(wgslCode, /lunarBRDF\s*:\s*f32/, "UB member lunarBRDF must exist");
  assert.match(
    wgslCode,
    /u32\(round\(u\.lunarBRDF\)\) == 1u/,
    "runtime flag branch (no ShaderDefine bit — registry exhausted, C12 exit criteria)",
  );
  assert.match(
    wgslCode,
    /2\.0 \* mu0 \/ \(mu0 \+ mu \+ 1\.0e-4\)/,
    "the Lommel-Seeliger disc law 2·μ0/(μ0+μ+ε)",
  );
  // μ0 against the selected light, μ against the eye — both clamped.
  assert.match(wgslCode, /let mu0 = max\(dot\(N, L\), 0\.0\);/);
  assert.match(wgslCode, /let mu = max\(dot\(N, toEyeMC\), 0\.0\);/);
});

test("GLSL: Lommel-Seeliger under LUNAR_BRDF with the identical formula", () => {
  assert.match(glsl, /#ifdef LUNAR_BRDF/);
  assert.match(
    glsl,
    /2\.0 \* mu0 \/ \(mu0 \+ mu \+ 1\.0e-4\)/,
    "formula must be character-identical to the WGSL twin",
  );
  // Respects onlySunLighting exactly like the phong paths.
  assert.match(glsl, /#ifdef ONLY_SUN_LIGHTING\s*\n\s*vec3 lunarLightDirEC = czm_sunDirectionEC;/);
  // The legacy phong paths must SURVIVE (the toggle's off-position).
  assert.match(glsl, /czm_private_phong/);
  assert.match(glsl, /czm_phong/);
});

test("EllipsoidPrimitive pushes the LUNAR_BRDF define from the lunarBRDF flag", () => {
  assert.match(primitive, /this\.lunarBRDF = false;/);
  assert.match(primitive, /fs\.defines\.push\("LUNAR_BRDF"\);/);
});

// ── C12-23 — opposition surge on both backends ──────────────────────────────

test("WGSL: oppositionSurge multiplies both the lunar and the legacy path", () => {
  assert.match(wgslCode, /oppositionSurge\s*:\s*f32/);
  assert.match(wgslCode, /lommelSeeliger \* u\.oppositionSurge/);
  assert.match(wgslCode, /phongCsmMaterial\(m, L, toEyeMC\) \* u\.oppositionSurge/);
});

test("GLSL: u_oppositionSurge under OPPOSITION_SURGE in every lighting path", () => {
  assert.match(glsl, /#ifdef OPPOSITION_SURGE\s*\n\s*uniform float u_oppositionSurge;/);
  const occurrences = glsl.match(/\*= u_oppositionSurge;/g) ?? [];
  assert.equal(
    occurrences.length,
    3,
    "surge multiply present in lunar + private_phong + phong paths",
  );
  assert.match(primitive, /fs\.defines\.push\("OPPOSITION_SURGE"\);/);
});

test("surge model: >40% rise from 4° to 0°, no effect at quarter phase", async () => {
  const { default: computeLunarOppositionSurge } = await import(
    pathToFileURL(
      path.join(root, "packages/engine/Source/Scene/computeLunarOppositionSurge.js"),
    ).href
  );
  const deg = (d) => (d * Math.PI) / 180;
  const s0 = computeLunarOppositionSurge(0);
  const s4 = computeLunarOppositionSurge(deg(4));
  assert.ok(s0 / s4 >= 1.4, `I(0)/I(4°) = ${s0 / s4} must be ≥ 1.4 (Buratti 1996)`);
  assert.ok(s0 / s4 <= 2.0, "…but not absurdly large");
  // Monotone decreasing away from opposition.
  let prev = s0;
  for (let a = 1; a <= 90; a += 1) {
    const s = computeLunarOppositionSurge(deg(a));
    assert.ok(s <= prev + 1e-12, `monotone at ${a}°`);
    prev = s;
  }
  assert.ok(computeLunarOppositionSurge(deg(90)) < 1.01, "inert at quarter phase");
  assert.equal(computeLunarOppositionSurge(NaN), 1.0, "identity on invalid input");
  assert.equal(computeLunarOppositionSurge(-1), 1.0, "identity on negative input");
});

// ── C12-30 — in-scattering sky-wash on both backends ────────────────────────

test("WGSL: additive inscatter in the final composite", () => {
  assert.match(wgslCode, /inscatter\s*:\s*vec3<f32>/);
  assert.match(
    wgslCode,
    /mixed\.rgb \* u\.extinction \+ u\.inscatter/,
    "disc = disc × extinction + inscatter",
  );
});

test("GLSL: additive u_atmosphereInscatter AFTER the extinction multiply", () => {
  assert.match(glsl, /#ifdef ATMOSPHERE_INSCATTER\s*\n\s*uniform vec3 u_atmosphereInscatter;/);
  const extinctionIdx = glsl.indexOf("out_FragColor.rgb *= u_atmosphereExtinction;");
  const inscatterIdx = glsl.indexOf("out_FragColor.rgb += u_atmosphereInscatter;");
  assert.ok(extinctionIdx >= 0, "extinction multiply still present");
  assert.ok(inscatterIdx > extinctionIdx, "wash adds after the extinction multiplies");
  assert.match(primitive, /fs\.defines\.push\("ATMOSPHERE_INSCATTER"\);/);
});

test("Moon.js publishes wash + surge; renderer packs the add-only UB tail", () => {
  assert.match(sceneMoon, /frameState\.moonAtmosphereInscatter = Cartesian3\.clone\(/);
  assert.match(sceneMoon, /frameState\.moonOppositionSurge = oppositionSurge;/);
  assert.match(sceneMoon, /enableMoonSkyWash === true/);
  assert.match(sceneMoon, /enableLunarBRDF === true/);
  assert.match(sceneMoon, /enableOppositionSurge === true/);
  // WebGPU pack: identities preserved (wash 0, surge 1) and offsets pinned.
  assert.match(envRenderer, /ud\[80\] = defined\(inscatter\) \? inscatter\.x : 0\.0;/);
  assert.match(envRenderer, /ud\[83\] = frameState\.moonOppositionSurge \?\? 1\.0;/);
  assert.match(envRenderer, /const MOON_UNIFORM_BUFFER_SIZE = 336;/);
  // ADD-ONLY: the frozen offsets must not have moved.
  assert.match(envRenderer, /ud\[67\] = frameState\.moonPhaseFraction \?\? 1\.0;/);
  assert.match(envRenderer, /ud\[76\] = defined\(extinction\) \? extinction\.x : 1\.0;/);
});

test("all three toggles exist on the lighting facade, default ON", () => {
  assert.match(conditions, /enableLunarBRDF: true,/);
  assert.match(conditions, /enableOppositionSurge: true,/);
  assert.match(conditions, /enableMoonSkyWash: true,/);
});

test("C11-176b contract intact: no phaseGate, phaseFraction only in the UB", () => {
  assert.ok(!wgslCode.includes("let phaseGate"));
  const occurrences = wgslCode.match(/phaseFraction/g) ?? [];
  assert.equal(occurrences.length, 1, "phaseFraction only as the UB member");
  assert.match(wgslCode, /phaseFraction\s*:\s*f32/);
  assert.match(wgsl, /var color = lit;/, "the unscaled lit composite stays");
});

// ── Integrator numeric contracts ────────────────────────────────────────────

test("in-scatter integrator: identities, day physics, night/orbit zeros", async () => {
  const mod = await import(
    pathToFileURL(
      path.join(root, "packages/engine/Source/Scene/computeAtmosphereExtinction.js"),
    ).href
  );
  const { computeAtmosphereInscatter } = mod;
  const { default: Cartesian3 } = await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/Cartesian3.js")).href
  );
  const atmosphere = {
    lightIntensity: 10.0,
    rayleighCoefficient: new Cartesian3(5.5e-6, 13.0e-6, 28.4e-6),
    mieCoefficient: new Cartesian3(21e-6, 21e-6, 21e-6),
    rayleighScaleHeight: 10000.0,
    mieScaleHeight: 3200.0,
    mieAnisotropy: 0.9,
  };
  const R = 6378137.0;
  const moonDist = 384400e3;
  const s2 = Math.SQRT1_2;
  const cam = new Cartesian3(R + 300, 0, 0);
  const sunUp = new Cartesian3(1, 0, 0);
  const moon45 = new Cartesian3(cam.x + moonDist * s2, 0, moonDist * s2);

  // Day, moon 45° up, sun overhead: a Rayleigh-blue wash in (0,1).
  const day = computeAtmosphereInscatter(
    new Cartesian3(), cam, moon45, sunUp, atmosphere, R, true, 2.2,
  );
  assert.ok(day.z > day.y && day.y > day.x, "blue-dominant day wash (Rayleigh)");
  assert.ok(day.z > 0.2 && day.z < 1.0, `day blue in a plausible display band (${day.z})`);

  // Horizon moon (3° up): longer path ⇒ brighter, whiter wash than 45°.
  const el = (3 * Math.PI) / 180;
  const moonHorizon = new Cartesian3(
    cam.x + moonDist * Math.sin(el), moonDist * Math.cos(el), 0,
  );
  const horizon = computeAtmosphereInscatter(
    new Cartesian3(), cam, moonHorizon, sunUp, atmosphere, R, true, 2.2,
  );
  assert.ok(horizon.x > day.x, "horizon wash brighter in red (whiter)");
  assert.ok(
    horizon.x / horizon.z > day.x / day.z,
    "horizon wash less blue-dominant (path-depleted blue)",
  );

  // Night (sun on the far side): the light march earth-shadows to zero.
  const night = computeAtmosphereInscatter(
    new Cartesian3(), cam, moon45, new Cartesian3(-1, 0, 0), atmosphere, R, true, 2.2,
  );
  assert.ok(night.x < 1e-4 && night.y < 1e-4 && night.z < 1e-4, "night wash ≈ 0");

  // Orbit looking away from Earth: ray misses the shell ⇒ EXACT zero.
  const orbit = computeAtmosphereInscatter(
    new Cartesian3(),
    new Cartesian3(8.0e6, 0, 0),
    new Cartesian3(8.0e6 + moonDist, 0, 0),
    sunUp, atmosphere, R, true, 2.2,
  );
  assert.equal(orbit.x, 0.0);
  assert.equal(orbit.y, 0.0);
  assert.equal(orbit.z, 0.0);

  // Missing input ⇒ additive identity.
  const missing = computeAtmosphereInscatter(
    new Cartesian3(), cam, moon45, undefined, atmosphere, R, true, 2.2,
  );
  assert.equal(missing.x, 0.0);
});

test("cached in-scatter wrapper: disabled ⇒ additive identity; enabled ⇒ cache hit", async () => {
  const mod = await import(
    pathToFileURL(
      path.join(root, "packages/engine/Source/Scene/computeAtmosphereExtinction.js"),
    ).href
  );
  const { createAtmosphereInscatterCache, computeAtmosphereInscatterCached } = mod;
  const { default: Cartesian3 } = await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/Cartesian3.js")).href
  );
  const atmosphere = {
    lightIntensity: 10.0,
    rayleighCoefficient: new Cartesian3(5.5e-6, 13.0e-6, 28.4e-6),
    mieCoefficient: new Cartesian3(21e-6, 21e-6, 21e-6),
    rayleighScaleHeight: 10000.0,
    mieScaleHeight: 3200.0,
    mieAnisotropy: 0.9,
  };
  const cache = createAtmosphereInscatterCache();
  const result = new Cartesian3(9, 9, 9);
  const R = 6378137.0;
  const cam = new Cartesian3(R + 300, 0, 0);
  const moon = new Cartesian3(R + 384400e3, 0, 0);
  const sun = new Cartesian3(1, 0, 0);

  // Disabled ⇒ (0,0,0), the additive identity.
  computeAtmosphereInscatterCached(cache, result, false, cam, moon, sun, atmosphere, R, true, 2.2);
  assert.deepEqual([result.x, result.y, result.z], [0, 0, 0]);

  // Enabled twice with identical inputs ⇒ exactly one computation.
  computeAtmosphereInscatterCached(cache, result, true, cam, moon, sun, atmosphere, R, true, 2.2);
  const first = { x: result.x, y: result.y, z: result.z };
  computeAtmosphereInscatterCached(cache, result, true, cam, moon, sun, atmosphere, R, true, 2.2);
  assert.equal(cache.computations, 1);
  assert.deepEqual({ x: result.x, y: result.y, z: result.z }, first);
});

// ── naga validation ─────────────────────────────────────────────────────────

test("Moon.wgsl passes naga validation", async () => {
  const nagaDirectory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() => naga.validate_wgsl(wgsl));
});
