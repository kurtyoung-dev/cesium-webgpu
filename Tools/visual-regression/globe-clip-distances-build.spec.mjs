// globe-clip-distances-build.spec.mjs — the opt-in hardware clip-distances
// globe path builds a real, valid shader module from the shipped globe source.
//
// @purpose Runs the real buildClipDistancesShaderSource over the real GlobeTerrain.wgsl after the real preprocessor for every define combination the globe compiles, and requires a non-null result that naga validates, alongside the validity of each un-augmented composed variant; a source whose anchor drifts must make the build return null.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/globe-clip-distances-build.spec.mjs
//
// THE OBSERVABLE. `Globe` can run its clipping planes through the device's
// `clip-distances` feature. That path does not ship its own shader: it
// rewrites the production source by string substitution, and when any anchor it
// searches for is missing it returns null and the renderer silently falls back
// to the per-fragment discard. A drifted anchor therefore never errors - the
// opt-in feature just stops working. The only way to see it is to RUN the
// transform over the source that ships.
//
// WHAT RUNS. The shipped `buildClipDistancesShaderSource`, the shipped
// `preprocess`, and naga (`Tools/shader-pipeline/naga-wasm-tools`) as the
// validator, over the define sets the globe is built under:
//
//   lo word  CAPTURE_MODE, GEODETIC_NORMAL, GLOBE_IMAGERY_REDUCED, LOG_DEPTH,
//            MATERIAL_APPLY  (all 32 subsets)
//   hi word  0 and ENHANCED_OCEAN
//
// 64 composed variants. A MATERIAL_APPLY variant calls the runtime's material
// function, which the globe renderer appends before preprocessing; the default
// material is appended here, as the renderer's material path would.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();
const { buildClipDistancesShaderSource } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts");
const { preprocess } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUShaderPreprocessor.ts");
const { ShaderDefine, ShaderDefineHi } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const GLOBE_WGSL = path.join(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);
const rawWgsl = fs.readFileSync(GLOBE_WGSL, "utf8").replace(/\r\n/g, "\n");

const nagaDirectory = path.join(ROOT, "Tools/shader-pipeline/naga-wasm-tools");
const naga = await import(
  pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
);
await naga.default({
  module_or_path: fs.readFileSync(
    path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
  ),
});

const LO_BITS = [
  ["CAPTURE_MODE", ShaderDefine.CAPTURE_MODE],
  ["GEODETIC_NORMAL", ShaderDefine.GEODETIC_NORMAL],
  ["GLOBE_IMAGERY_REDUCED", ShaderDefine.GLOBE_IMAGERY_REDUCED],
  ["LOG_DEPTH", ShaderDefine.LOG_DEPTH],
  ["MATERIAL_APPLY", ShaderDefine.MATERIAL_APPLY],
];
const HI_SETS = [
  ["", 0],
  ["+ENHANCED_OCEAN", ShaderDefineHi.ENHANCED_OCEAN],
];
const MATERIAL_FUNCTION =
  "\nfn czm_getMaterial(input: czm_MaterialInput) -> czm_Material { return czm_getDefaultMaterial(input); }\n";

/** Every define combination, as `{name, lo, hi, materialApply}`. */
function defineSets() {
  const sets = [];
  for (let subset = 0; subset < 1 << LO_BITS.length; subset += 1) {
    const names = [];
    let lo = 0;
    LO_BITS.forEach(([name, bit], index) => {
      if (subset & (1 << index)) {
        names.push(name);
        lo |= bit;
      }
    });
    for (const [hiName, hi] of HI_SETS) {
      sets.push({
        name: `${names.join("|") || "none"}${hiName}`,
        lo,
        hi,
        materialApply: (lo & ShaderDefine.MATERIAL_APPLY) !== 0,
      });
    }
  }
  return sets;
}

/** The globe module's source as the renderer composes it for one define set. */
function compose(source, set) {
  const base = set.materialApply ? source + MATERIAL_FUNCTION : source;
  return preprocess(base, set.lo, set.hi);
}

/**
 * Every failure of the build over a source text: a null transform, or a result
 * (or the composed base) naga rejects.
 *
 * @param {string} source GlobeTerrain.wgsl text (possibly mutated).
 * @returns {{failures: string[], built: number}} What went wrong, and how many built.
 */
function buildFailures(source) {
  const failures = [];
  let built = 0;
  for (const set of defineSets()) {
    const composed = compose(source, set);
    const augmented = buildClipDistancesShaderSource(composed);
    if (augmented === null) {
      failures.push(`${set.name}: the clip-distances transform returned null`);
      continue;
    }
    built += 1;
    try {
      naga.validate_wgsl(augmented);
    } catch (error) {
      failures.push(
        `${set.name}: naga rejected the clip-distances module: ${String(error).slice(0, 160)}`,
      );
    }
  }
  return { failures, built };
}

test("E1: the fixture is the full define space (32 lo subsets x 2 hi words)", () => {
  assert.equal(defineSets().length, 64);
  assert.equal(new Set(defineSets().map((s) => s.name)).size, 64);
});

test("E2: every composed globe variant is valid WGSL", () => {
  const failures = [];
  for (const set of defineSets()) {
    try {
      naga.validate_wgsl(compose(rawWgsl, set));
    } catch (error) {
      failures.push(`${set.name}: ${String(error).slice(0, 160)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("E3: the clip-distances build is non-null and naga-valid for every define set", () => {
  const { failures, built } = buildFailures(rawWgsl);
  assert.deepEqual(failures, []);
  assert.equal(built, 64);
});

test("E4: the built module differs from its base by the hardware clip distances (the path is not a no-op)", () => {
  for (const set of defineSets().filter((_, index) => index % 9 === 0)) {
    const composed = compose(rawWgsl, set);
    const augmented = buildClipDistancesShaderSource(composed);
    assert.notEqual(augmented, null);
    assert.ok(
      augmented.length > composed.length,
      `${set.name}: nothing was added`,
    );
    assert.ok(
      augmented.includes("clip_distances"),
      `${set.name}: no clip-distances output`,
    );
  }
});

// A mutant is a source whose anchors have drifted. The fix being inert means
// the null comes back; the check must see it, for every define set.
const MUTANTS = {
  "the fragment discard no longer reads as the transform expects": (source) => {
    const pattern = /if \(globeClipByPlanes\([^)]*\)\) \{ discard; \}/g;
    assert.ok(pattern.test(source), "mutation target not found");
    return source.replace(
      /if \(globeClipByPlanes\(([^)]*)\)\) \{ discard; \}/g,
      (_, argument) =>
        `if (globeClipByPlanes(${argument})) {\n    discard;\n  }`,
    );
  },
  "the vertex output loses its v_distance member": (source) => {
    assert.ok(
      source.includes("@location(4) v_distance: f32,"),
      "mutation target not found",
    );
    return source.replace(
      "@location(4) v_distance: f32,",
      "@location(4) v_distanceX: f32,",
    );
  },
};

for (const [name, mutate] of Object.entries(MUTANTS)) {
  test(`E5: mutant (${name}) is caught`, () => {
    const { failures, built } = buildFailures(mutate(rawWgsl));
    assert.ok(failures.length > 0, "the drifted source went undetected");
    assert.ok(built < 64);
    assert.ok(
      failures.some((line) => line.includes("returned null")),
      "the failure is the silent null",
    );
  });
}
