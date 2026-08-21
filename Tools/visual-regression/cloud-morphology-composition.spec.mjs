/**
 * C13-16 U2 — LOCAL, uncommitted cloud-morphology composition contract.
 * @purpose C13-16 U2 candidate contract: genus-conditioned variance budget + fibre carve before erosion; WGSL wiring invariants and carve-after-erosion mutants.
 * @status ACTIVE
 *
 * The transfer model approved one indivisible operating point: apply a small
 * genus-conditioned base-field variance budget, multiply the fibre carve before
 * erosion, and compensate the erosion depth on the same genus-strength axis.
 * This spec pins the WGSL wiring, its arithmetic invariants, and mutants that
 * recreate the old carve-after-erosion defect.
 *
 * Run:
 *   node --test Tools/visual-regression/cloud-morphology-composition.spec.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import CloudType from "../../packages/engine/Source/Scene/CloudType.js";
import CloudTypeProfile from "../../packages/engine/Source/Scene/CloudTypeProfile.js";
import {
  BASE_FIELD_MEAN,
  U2_CANDIDATE,
  buildModelParameters,
} from "./lib/cloud-march-transfer-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const shaderPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
);
const shaderSource = fs
  .readFileSync(shaderPath, "utf8")
  .replace(
    new RegExp(String.fromCharCode(13) + String.fromCharCode(10), "g"),
    String.fromCharCode(10),
  );

function functionSource(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  assert.fail(`unterminated function ${name}`);
}

function mustReplace(source, search, replacement) {
  assert.ok(
    source.includes(search),
    "mutation anchor missing: " + JSON.stringify(String(search).slice(0, 60)),
  );
  const out = source.replace(search, replacement);
  assert.notStrictEqual(out, source, "mutation did not change the source");
  return out;
}

function constantValue(source, name) {
  const match = source.match(
    new RegExp(`const\\s+${name}:\\s*f32\\s*=\\s*([0-9.]+);`),
  );
  assert.ok(match, `missing ${name}`);
  return Number(match[1]);
}

function countMatches(source, expression) {
  return [...source.matchAll(expression)].length;
}

function orderedIndex(source, needle, after, message) {
  const index = source.indexOf(needle, after + 1);
  assert.ok(index > after, message);
  return index;
}

function assertHelperComposition(source) {
  const budget = functionSource(source, "applyGenusBaseVarianceBudget");
  assert.match(
    budget,
    /let\s+strength\s*=\s*clamp\(cloud\.genusFibreStrength,\s*0\.0,\s*1\.0\);/,
    "budget strength must use the shared clamped genus axis",
  );
  assert.match(
    budget,
    /if\s*\(strength <= 0\.0\)\s*\{\s*return gatedDensity;/,
    "CUMULUS must take an exact budget identity return",
  );
  assert.match(
    budget,
    /let\s+aspect\s*=\s*max\(cloud\.genusFibreAnisotropy,\s*1\.0\);\s*let\s+directionality\s*=\s*1\.0\s*-\s*1\.0\s*\/\s*aspect;/,
    "budget must be conditioned by anisotropic directionality",
  );
  assert.match(
    budget,
    /let\s+budgetWeight\s*=\s*clamp\(\s*GENUS_BASE_VARIANCE_BUDGET\s*\*\s*strength\s*\*\s*directionality,\s*0\.0,\s*1\.0,?\s*\);/,
    "budget weight must use the approved strength/directionality law",
  );
  assert.match(
    budget,
    /let\s+pivot\s*=\s*smoothstep\(\s*coverageThreshold,\s*1\.0,\s*GENUS_BASE_FIELD_MEAN,?\s*\);/,
    "the shader twin must use the approved constant base-field pivot",
  );
  assert.match(
    budget,
    /let\s+weight\s*=\s*select\(\s*budgetWeight,\s*budgetWeight\s*\*\s*GENUS_BASE_VARIANCE_DOWN_WEIGHT,\s*pivot\s*<\s*gatedDensity,?\s*\);/,
    "the approved asymmetric down-weight must remain intact",
  );
  assert.match(
    budget,
    /return\s+gatedDensity\s*\+\s*\(pivot\s*-\s*gatedDensity\)\s*\*\s*weight;/,
    "budget helper must return the approved non-identity composition",
  );

  const compensation = functionSource(source, "genusErosionDepthScale");
  assert.match(
    compensation,
    /if\s*\(strength <= 0\.0\)\s*\{\s*return 1\.0;/,
    "CUMULUS must take an exact erosion-scale identity return",
  );
  assert.match(
    compensation,
    /return\s+1\.0\s*-\s*GENUS_EROSION_COMPENSATION\s*\*\s*strength;/,
    "erosion helper must return the approved compensation law",
  );
}

function assertEvaluatorComposition(source) {
  const sites = [
    {
      name: "legacyCloudDensity",
      coordinate: "samplePos",
      height: "density *= heightGradient;",
      erosionBoundary: "if (noiseBakedEnabled())",
    },
    {
      name: "legacyCloudBaseDensity",
      coordinate: "samplePos",
      height: "density *= heightGradient;",
      erosionBoundary: "return density *",
    },
    {
      name: "cloudMacroSampleAt",
      coordinate: "morphologyCoordinate",
      height: "density *= heightGradientFor(",
      erosionBoundary: "let factor =",
    },
  ];
  for (const site of sites) {
    const body = functionSource(source, site.name);
    assert.equal(
      countMatches(body, /applyGenusBaseVarianceBudget\(/g),
      1,
      `${site.name} must apply the budget exactly once`,
    );
    assert.equal(
      countMatches(
        body,
        /density\s*=\s*applyGenusBaseVarianceBudget\(density,\s*coverageThreshold\);/g,
      ),
      1,
      `${site.name} must assign the budget result back to density`,
    );
    assert.equal(
      countMatches(body, /genusFibreFactor\(/g),
      1,
      `${site.name} must apply the carve exactly once`,
    );
    assert.match(
      body,
      new RegExp(
        `let\\s+genusFibre\\s*=\\s*genusFibreFactor\\(${site.coordinate},\\s*heightFraction\\);\\s*` +
          "density\\s*\\*=\\s*genusFibre;",
      ),
      `${site.name} must multiply the carve into pre-erosion density`,
    );
    const gateAt = orderedIndex(
      body,
      "density = smoothstep(coverageThreshold, 1.0, density);",
      -1,
      `${site.name} is missing its coverage gate`,
    );
    const budgetAt = orderedIndex(
      body,
      "density = applyGenusBaseVarianceBudget(density, coverageThreshold);",
      gateAt,
      `${site.name} must apply budget after the coverage gate`,
    );
    const heightAt = orderedIndex(
      body,
      site.height,
      budgetAt,
      `${site.name} must apply height after budget`,
    );
    const carveAt = orderedIndex(
      body,
      "density *= genusFibre;",
      heightAt,
      `${site.name} must apply carve after height`,
    );
    orderedIndex(
      body,
      site.erosionBoundary,
      carveAt,
      `${site.name} must apply carve before erosion/factor completion`,
    );
  }
}

function assertCallGraph(source) {
  const atCoordinates = functionSource(source, "cloudDensityAtCoordinates");
  const macroAt = orderedIndex(
    atCoordinates,
    "cloudMacroSampleAt(",
    -1,
    "coordinate evaluator must create one macro sample",
  );
  orderedIndex(
    atCoordinates,
    "cloudDensityFromMacro(",
    macroAt,
    "coordinate evaluator must erode the same macro sample",
  );
  assert.equal(countMatches(atCoordinates, /cloudMacroSampleAt\(/g), 1);
  assert.equal(countMatches(atCoordinates, /cloudDensityFromMacro\(/g), 1);

  for (const wrapper of [
    "cloudDensityWithFootprint",
    "cloudDensityRelativeWithFootprint",
  ]) {
    const body = functionSource(source, wrapper);
    assert.equal(
      countMatches(body, /legacyCloudDensity\(/g),
      1,
      `${wrapper} must preserve the legacy fallback`,
    );
    assert.equal(
      countMatches(body, /cloudDensityAtCoordinates\(/g),
      1,
      `${wrapper} must converge on the macro/full evaluator`,
    );
  }

  const shadow = functionSource(source, "cloudShadowMain");
  assert.equal(
    countMatches(shadow, /cloudDensityRelativeWithFootprint\(/g),
    1,
    "RTE shadow march must use the relative density wrapper",
  );
  assert.equal(
    countMatches(shadow, /cloudDensityWithFootprint\(/g),
    1,
    "shadow comparison route must use the world density wrapper",
  );

  const march = functionSource(source, "marchDeck");
  for (const callee of [
    "cloudMacroSampleAt",
    "cloudBaseFromMacro",
    "cloudDensityFromMacro",
    "legacyCloudBaseDensity",
    "legacyCloudDensity",
  ]) {
    assert.ok(
      countMatches(march, new RegExp(`${callee}\\(`, "g")) >= 1,
      `visible march must retain its ${callee} route`,
    );
  }

  const straightLight = functionSource(source, "lightMarch");
  assert.equal(countMatches(straightLight, /cloudDensityAtCoordinates\(/g), 1);
  assert.equal(countMatches(straightLight, /legacyCloudDensity\(/g), 1);
  const coneLight = functionSource(source, "lightMarchCone");
  for (const callee of [
    "cloudDensityAtCoordinates",
    "legacyCloudDensity",
    "cloudMacroSampleAt",
    "cloudBaseFromMacro",
    "legacyCloudBaseDensity",
  ]) {
    assert.ok(
      countMatches(coneLight, new RegExp(`${callee}\\(`, "g")) >= 1,
      `cone-light march must retain its ${callee} route`,
    );
  }
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

const f32 = Math.fround;

function smoothstep(low, high, value) {
  const x = clamp(f32(f32(value - low) / f32(high - low)), 0, 1);
  return f32(f32(x * x) * f32(3 - f32(2 * x)));
}

function applyBudget(gatedDensity, threshold, strength, anisotropy) {
  const s = clamp(strength, 0, 1);
  if (s <= 0) {
    return gatedDensity;
  }
  const aspect = Math.max(anisotropy, 1);
  const directionality = f32(1 - f32(1 / aspect));
  const budgetWeight = clamp(
    f32(f32(U2_CANDIDATE.baseVarianceBudget * s) * directionality),
    0,
    1,
  );
  if (budgetWeight <= 0) {
    return gatedDensity;
  }
  const pivot = smoothstep(threshold, 1, BASE_FIELD_MEAN);
  const weight =
    pivot < gatedDensity
      ? f32(budgetWeight * U2_CANDIDATE.budgetDownWeight)
      : budgetWeight;
  return f32(gatedDensity + f32(f32(pivot - gatedDensity) * weight));
}

function erosionDepthScale(strength) {
  const s = clamp(strength, 0, 1);
  if (s <= 0) {
    return 1;
  }
  return f32(1 - f32(U2_CANDIDATE.erosionCompensation * s));
}

test("the WGSL constants are the model-approved U2 operating point", () => {
  assert.equal(
    constantValue(shaderSource, "GENUS_BASE_FIELD_MEAN"),
    BASE_FIELD_MEAN,
  );
  assert.equal(
    constantValue(shaderSource, "GENUS_BASE_VARIANCE_BUDGET"),
    U2_CANDIDATE.baseVarianceBudget,
  );
  assert.equal(
    constantValue(shaderSource, "GENUS_BASE_VARIANCE_DOWN_WEIGHT"),
    U2_CANDIDATE.budgetDownWeight,
  );
  assert.equal(
    constantValue(shaderSource, "GENUS_EROSION_COMPENSATION"),
    U2_CANDIDATE.erosionCompensation,
  );
});

test("all three density evaluators share budget -> height -> carve -> erosion ordering", () => {
  assertHelperComposition(shaderSource);
  assertEvaluatorComposition(shaderSource);
  assertCallGraph(shaderSource);

  const legacy = functionSource(shaderSource, "legacyCloudDensity");
  assert.equal(countMatches(legacy, /genusErosionDepthScale\(\)/g), 2);
  const macroFull = functionSource(shaderSource, "cloudDensityFromMacro");
  assert.equal(countMatches(macroFull, /genusErosionDepthScale\(\)/g), 1);
});

test("CUMULUS takes exact identity returns and the uniform layout does not grow", () => {
  const budget = functionSource(shaderSource, "applyGenusBaseVarianceBudget");
  assert.match(budget, /if \(strength <= 0\.0\)\s*\{\s*return gatedDensity;/);
  const compensation = functionSource(shaderSource, "genusErosionDepthScale");
  assert.match(compensation, /if \(strength <= 0\.0\)\s*\{\s*return 1\.0;/);

  const row = CloudTypeProfile.getFibreMorphology(CloudType.CUMULUS);
  assert.equal(row.strength, 0);
  const params = buildModelParameters({
    cloudType: CloudType.CUMULUS,
    ...U2_CANDIDATE,
  });
  assert.equal(U2_CANDIDATE.budgetPivotQuantile, BASE_FIELD_MEAN);
  assert.equal(params.budgetWeight, 0);
  assert.equal(params.erosionDepthScale, 1);
  for (const value of [0, f32(1 / 255), 0.125, 0.5, 0.999999, 1]) {
    assert.equal(applyBudget(value, 0.2, row.strength, row.anisotropy), value);
  }

  // The sign-off explicitly forbids a uniform-tail workaround.
  assert.match(shaderSource, /genusPhaseDelta:\s*f32,\s*\/\/ 171/);
  assert.doesNotMatch(shaderSource, /genusBaseVarianceBudget:\s*f32/);
});

test("the budget is asymmetric and conditioned by both strength and directionality", () => {
  const threshold = 0.2;
  const pivot = smoothstep(threshold, 1, BASE_FIELD_MEAN);
  const offset = f32(Math.min(pivot, 1 - pivot) * 0.5);
  const trough = f32(pivot - offset);
  const peak = f32(pivot + offset);
  const troughDelta = applyBudget(trough, threshold, 0.6, 9) - trough;
  const peakDelta = peak - applyBudget(peak, threshold, 0.6, 9);
  assert.ok(troughDelta > peakDelta * 3.9, `${troughDelta} vs ${peakDelta}`);
  assert.equal(applyBudget(peak, threshold, 0.6, 1), peak);
  assert.equal(applyBudget(peak, threshold, 0, 9), peak);
});

test("base >= full over the supported normalized erosionLo domain [0, 1)", () => {
  // The remap has a pole at erosionLo=1. This proof therefore covers the
  // renderer's normalized/default operating domain below that endpoint. The
  // public erosion-strength override is not currently range-validated; its
  // contract is queued separately rather than silently changed by this slice.
  for (const strength of [0, 0.4, 0.6, 1]) {
    for (const anisotropy of [1, 2, 5, 9]) {
      for (const threshold of [0, 0.2, 0.55, 0.9]) {
        for (let i = 0; i <= 64; i++) {
          const gated = f32(i / 64);
          const shaped = applyBudget(gated, threshold, strength, anisotropy);
          for (const fibre of [0, 0.1, 0.5, 1]) {
            const base = f32(shaped * fibre);
            for (const rawErosion of [0, 0.01, 0.1, 0.5, 0.99]) {
              const erosion = f32(rawErosion * erosionDepthScale(strength));
              const subtractive = Math.max(f32(base - erosion), 0);
              const remapped = clamp(
                f32(f32(base - erosion) / f32(1 - erosion)),
                0,
                1,
              );
              assert.ok(subtractive <= base, "subtractive full exceeded base");
              assert.ok(remapped <= base, "remapped full exceeded base");
            }
          }
        }
      }
    }
  }
});

test("MUTATION: moving the carve behind the live zero clamp is rejected", () => {
  const original = functionSource(shaderSource, "legacyCloudDensity");
  const moved = mustReplace(
    mustReplace(original, "  density *= genusFibre;\n", ""),
    "    density = max(density, 0.0);",
    "    density = max(density, 0.0);\n    density *= genusFibre;",
  );
  const mutated = mustReplace(shaderSource, original, moved);
  assert.throws(
    () => assertEvaluatorComposition(mutated),
    /multiply the carve|carve before erosion/,
  );
});

test("MUTATION: dropping one evaluator's budget call is rejected", () => {
  const start = shaderSource.indexOf("fn legacyCloudBaseDensity(");
  const call = shaderSource.indexOf(
    "density = applyGenusBaseVarianceBudget(density, coverageThreshold);",
    start,
  );
  assert.ok(call > start);
  const mutated =
    shaderSource.slice(0, call) +
    "density = density;" +
    shaderSource.slice(
      call +
        "density = applyGenusBaseVarianceBudget(density, coverageThreshold);"
          .length,
    );
  assert.throws(
    () => assertEvaluatorComposition(mutated),
    /budget exactly once/,
  );
});

test("MUTATION: discarding the budget result is rejected", () => {
  const mutated = mustReplace(
    shaderSource,
    "density = applyGenusBaseVarianceBudget(density, coverageThreshold);",
    "let discardedBudget = applyGenusBaseVarianceBudget(density, coverageThreshold);",
  );
  assert.throws(
    () => assertEvaluatorComposition(mutated),
    /assign the budget result/,
  );
});

test("MUTATION: moving budget behind height and carve is rejected", () => {
  const original = functionSource(shaderSource, "legacyCloudBaseDensity");
  const moved = mustReplace(
    mustReplace(
      original,
      "  density = applyGenusBaseVarianceBudget(density, coverageThreshold);\n",
      "",
    ),
    "  density *= genusFibre;",
    "  density *= genusFibre;\n  density = applyGenusBaseVarianceBudget(density, coverageThreshold);",
  );
  const mutated = mustReplace(shaderSource, original, moved);
  assert.throws(
    () => assertEvaluatorComposition(mutated),
    /budget after the coverage gate|height after budget/,
  );
});

test("MUTATION: a no-op budget helper is rejected", () => {
  const original = functionSource(shaderSource, "applyGenusBaseVarianceBudget");
  const mutated = mustReplace(
    shaderSource,
    original,
    mustReplace(
      original,
      "return gatedDensity + (pivot - gatedDensity) * weight;",
      "return gatedDensity;",
    ),
  );
  assert.throws(
    () => assertHelperComposition(mutated),
    /non-identity composition/,
  );
});

test("MUTATION: a no-op erosion compensation helper is rejected", () => {
  const original = functionSource(shaderSource, "genusErosionDepthScale");
  const mutated = mustReplace(
    shaderSource,
    original,
    mustReplace(
      original,
      "return 1.0 - GENUS_EROSION_COMPENSATION * strength;",
      "return 1.0;",
    ),
  );
  assert.throws(
    () => assertHelperComposition(mutated),
    /approved compensation law/,
  );
});

test("MUTATION: bypassing the shared macro-to-full evaluator is rejected", () => {
  const original = functionSource(shaderSource, "cloudDensityAtCoordinates");
  const mutated = mustReplace(
    shaderSource,
    original,
    mustReplace(
      original,
      "return cloudDensityFromMacro(macroSample, heightFraction);",
      "return macroSample.preErosion * macroSample.densityFactor;",
    ),
  );
  assert.throws(() => assertCallGraph(mutated), /erode the same macro sample/);
});

test("MUTATION: diverting the RTE shadow density route is rejected", () => {
  const original = functionSource(shaderSource, "cloudShadowMain");
  const mutated = mustReplace(
    shaderSource,
    original,
    mustReplace(
      original,
      "cloudDensityRelativeWithFootprint(",
      "cloudDensityWithFootprint(",
    ),
  );
  assert.throws(() => assertCallGraph(mutated), /RTE shadow march/);
});

test("MUTATION: a renamed compensation constant is rejected", () => {
  const mutated = mustReplace(
    shaderSource,
    "GENUS_EROSION_COMPENSATION: f32",
    "GENUS_EROSION_COMPENSATIO: f32",
  );
  assert.throws(
    () => constantValue(mutated, "GENUS_EROSION_COMPENSATION"),
    /missing GENUS_EROSION_COMPENSATION/,
  );
});
