// moon-phase-gate.spec.mjs — C11-176b: pins the Moon.wgsl phaseGate deletion.
//
// The defect: Moon.wgsl multiplied the whole Phong-lit disc by
//     let phaseGate = smoothstep(0.0, 0.3, u.phaseFraction);
//     var color = lit * phaseGate;
// which double-counted phase (N·L against the real Simon1994 sun direction
// already yields the terminator + illuminated fraction) and blacked out the
// entire disc — real crescent included — at small sun-moon elongations
// (every daytime moon near the sun; the C12-30 "dark blob"). No GLSL file
// ever had the term; WebGL (EllipsoidPrimitive + czm_private_phong) was
// already correct.
//
// These tests are the regression tripwire: they fail if the gate (or any
// other whole-disc multiplier keyed on phaseFraction) reappears, if the
// C12-21 scaffolding (phaseFraction in the UB, frameState.moonPhaseFraction
// publication) is trimmed, or if the shader stops validating under naga.
//
// Run: node --test Tools/visual-regression/moon-phase-gate.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const shaderPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
);
const sceneMoonPath = path.join(root, "packages/engine/Source/Scene/Moon.js");
const envRendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
);

const shaderSource = fs.readFileSync(shaderPath, "utf8");
const sceneMoonSource = fs.readFileSync(sceneMoonPath, "utf8");
const envRendererSource = fs.readFileSync(envRendererPath, "utf8");

test("the phaseGate blackout multiplier is gone from Moon.wgsl", () => {
  // The deleted expressions live on in explanatory comments (deliberately —
  // Principle 7 wants the deletion rationale in-file), so all gate-absence
  // checks run against comment-STRIPPED code. WGSL here uses only `//`.
  const codeOnly = shaderSource
    .split("\n")
    .map((line) => {
      const slash = line.indexOf("//");
      return slash >= 0 ? line.slice(0, slash) : line;
    })
    .join("\n");
  // The exact expressions that produced the blackout.
  assert.ok(
    !codeOnly.includes("let phaseGate"),
    "phaseGate local must not exist",
  );
  assert.doesNotMatch(
    codeOnly,
    /smoothstep\(\s*0\.0\s*,\s*0\.3\s*,\s*u\.phaseFraction\s*\)/,
    "the smoothstep(0.0, 0.3, u.phaseFraction) gate must not exist",
  );
  // No whole-disc multiplier keyed on phaseFraction in ANY form: the only
  // remaining phaseFraction occurrence must be the UB declaration.
  const occurrences = codeOnly.match(/phaseFraction/g) ?? [];
  assert.equal(
    occurrences.length,
    1,
    "phaseFraction may appear exactly once in code — the UB member declaration (C12-21 scaffolding)",
  );
  assert.match(
    codeOnly,
    /phaseFraction\s*:\s*f32/,
    "that single occurrence must be the uniform declaration",
  );
});

test("the lit disc now follows Phong N·L directly (WebGL convergence)", () => {
  // The Phong result must flow into the composite unscaled. This is the
  // exact post-fix line; any reintroduced multiplier changes it.
  assert.match(
    shaderSource,
    /var color = lit;/,
    "color must start as the unscaled Phong result",
  );
  // Earthshine (a WebGPU-only additive, gated OFF by default) must still be
  // additive on the unlit side and keyed on raw N·L, not on phaseFraction.
  assert.match(shaderSource, /let rawNdotL = max\(dot\(N, L\), 0\.0\);/);
  assert.match(
    shaderSource,
    /\(1\.0 - rawNdotL\)/,
    "earthshine remains keyed on raw N·L",
  );
});

test("C12-21 scaffolding intact: phaseFraction still packed and published", () => {
  // UB layout: phaseFraction stays in the struct (offset 268, .w of
  // moonDirWC's vec4 slot) for C12-21 phase-dependent earthshine.
  assert.match(shaderSource, /moonDirWC: vec3<f32>, phaseFraction: f32/);
  // JS pack still writes it (WebGPUEnvironmentRenderer offset 67).
  assert.match(
    envRendererSource,
    /ud\[67\] = frameState\.moonPhaseFraction \?\? 1\.0;/,
  );
  // Scene/Moon.js still publishes frameState.moonPhaseFraction — consumed by
  // the sky atmosphere, volumetric fog, and sky brightness as a moonlight
  // intensity proxy (legitimate scalar uses, unlike the deleted disc gate).
  assert.match(sceneMoonSource, /frameState\.moonPhaseFraction = phaseFraction;/);
  assert.match(
    sceneMoonSource,
    /phaseFraction = 0\.5 \* \(1\.0 - cosAngle\);/,
    "the illuminated-fraction derivation stays for the scalar consumers",
  );
});

test("no GLSL moon file gained a phase multiplier (parity direction check)", () => {
  // WebGL was correct BECAUSE it has no phase term: the fix direction is
  // WGSL converging to GLSL, never GLSL gaining the gate. EllipsoidFS is
  // the WebGL moon fragment path.
  const ellipsoidFS = fs.readFileSync(
    path.join(root, "packages/engine/Source/Shaders/EllipsoidFS.glsl"),
    "utf8",
  );
  assert.ok(!ellipsoidFS.includes("phaseFraction"));
  assert.ok(!ellipsoidFS.includes("phaseGate"));
});

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
  assert.doesNotThrow(() => naga.validate_wgsl(shaderSource));
});
