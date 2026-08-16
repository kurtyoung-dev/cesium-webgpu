// RUNNER REQUIREMENT: Node >= 22.18. This spec's model imports a `.ts` module
// (WebGPUCloudDensityDomain.ts) and relies on Node's built-in type stripping,
// which is on by default only from 22.18 onward; on 22.6-22.17 add
// `--experimental-strip-types`.
// @purpose Pins the CLOUD-LOW-COVERAGE-CUTOFF fix: baked base-field support, monotone coverage response on the CPU twin, exact high-anchor preservation.
// @status ACTIVE
//
// CLOUD-LOW-COVERAGE-CUTOFF — the coverage -> density response contract.
//
// The C13-01 tour found, and an isolated single-variable coverage sweep
// confirmed, that the volumetric cloud renderer rendered EXACTLY ZERO cloud at
// cloudCoverage <= 0.40 (0.0009 at 0.45, healthy at 0.55): every real-world
// fair-weather scattered-cumulus sky rendered clear. This file pins the fix so
// the class cannot come back:
//
//   1. the ROOT CAUSE is stated as a checkable fact about the baked base field,
//      not as prose — the historical threshold provably leaves the field's
//      support, so a future change that re-narrows the field fails here;
//   2. the response curve is pinned at the acceptance's sampled coverages with
//      MONOTONICITY, using the CPU twin rather than a screenshot;
//   3. feature preservation is pinned as EXACT equality with the historical
//      response at and above the anchor, so "fixed the low end by moving the
//      whole curve" fails;
//   4. the negative-space control (coverage 0.05) is still exactly clear, so
//      "fixed it by making everything cloudy" fails.
//
// Everything here is a distributional property with margin. The twin's noise
// hash is f64 where a GPU's is f32 (see the model's header), so exact rendered
// luminance is the tour's and the coverage sweep's job, not this file's.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultVariant } from "./lib/wgsl-variant.mjs";

import {
  CLOUD_COVERAGE_ANCHOR,
  cloudEffectiveCoverage,
  deckResponseStats,
  historicalEffectiveCoverage,
  sampleDeckField,
  summarizeBaseField,
} from "./lib/cloud-coverage-response-model.mjs";
import { CLOUD_COVERAGE_EXPONENT } from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const domainSource = read(
  "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
);
const cloudSource = read(
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
);
const iblSource = read(
  "packages/engine/Source/Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl",
);
const twinSource = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts",
);

// The acceptance's sampled coverages.
const SAMPLED = [0.15, 0.25, 0.35, 0.45, 0.55];

// One field build serves every case in this file.
const field = sampleDeckField();
const baseField = summarizeBaseField(field);
const statsFor = (coverage, response) =>
  deckResponseStats(field, { coverage, response });

// ── 1. Root cause, as a checkable fact ────────────────────────────────────

test("the baked base field cannot reach the historical low-coverage threshold", () => {
  // The gate is smoothstep(1 - coverage, 1, base). The historical response fed
  // it the coverage directly, which is only meaningful if `base` spans [0, 1].
  assert.ok(
    baseField.max < 0.75,
    `baked base max ${baseField.max} — the field is expected to be a narrow ` +
      `near-Gaussian, not a uniform`,
  );
  assert.ok(baseField.sigma < 0.12, `baked base sigma ${baseField.sigma}`);

  // Therefore there is a coverage below which the historical gate is zero for
  // every sample in the world — not "dim", structurally zero.
  const structuralZeroCoverage = 1 - baseField.max;
  assert.ok(
    structuralZeroCoverage > 0.2,
    `historical gate only self-destructs below coverage ${structuralZeroCoverage}`,
  );
  assert.equal(baseField.exceedance(1 - 0.25), 0);
});

test("the historical response is reproduced, and is the defect", () => {
  for (const coverage of [0.15, 0.25]) {
    const historical = statsFor(coverage, historicalEffectiveCoverage);
    assert.equal(
      historical.volumeFraction,
      0,
      `historical response at ${coverage} was expected to render nothing`,
    );
    assert.equal(historical.skyCover, 0);
  }
  // 0.35 is the plains fixture's real-world value: not identically zero, but
  // below anything a viewer could see.
  const plains = statsFor(0.35, historicalEffectiveCoverage);
  assert.ok(plains.volumeFraction < 0.002, `${plains.volumeFraction}`);
  assert.equal(plains.skyCover, 0);
});

// ── 2. The shipped curve: WGSL and its CPU twin ───────────────────────────

test("the WGSL response and its CPU twin are one definition", () => {
  assert.match(
    domainSource,
    /const CLOUD_COVERAGE_ANCHOR: f32 = 0\.55;/,
    "the WGSL anchor moved without this contract",
  );
  assert.match(domainSource, /const CLOUD_COVERAGE_EXPONENT: f32 = 0\.25;/);
  assert.equal(CLOUD_COVERAGE_ANCHOR, 0.55);
  assert.equal(CLOUD_COVERAGE_EXPONENT, 0.25);

  // The ratio spelling is what makes the anchor exact in f32 — a pre-multiplied
  // constant would round and break the preservation guarantee below.
  assert.match(
    domainSource,
    /CLOUD_COVERAGE_ANCHOR\s*\*\s*\n?\s*pow\(c\s*\/\s*CLOUD_COVERAGE_ANCHOR,\s*CLOUD_COVERAGE_EXPONENT\)/,
  );
  assert.match(domainSource, /return max\(c, lifted\);/);
  assert.match(twinSource, /Math\.pow\(ratio, exponent\)/);
  assert.match(twinSource, /return Math\.max\(c, lifted\);/);

  // The domain chunk stays pure: it is prepended to shaders that bind textures,
  // and the existing domain contract forbids it from doing any binding itself.
  assert.doesNotMatch(
    domainSource,
    /textureSample|textureLoad|textureStore|@group|@binding/,
  );
});

test("every coverage gate in the engine routes through the shared response", () => {
  const gates = [...cloudSource.matchAll(/smoothstep\(\s*1\.0 - ([^,]+),/g)];
  assert.equal(gates.length, 3, "the visible march has three density gates");
  for (const [, argument] of gates) {
    assert.match(argument, /^cloudEffectiveCoverage\(effectiveCoverage\)$/);
  }

  const iblGates = [...iblSource.matchAll(/smoothstep\(1\.0 - ([^,]+),/g)];
  assert.equal(iblGates.length, 1);
  assert.equal(iblGates[0][1], "cloudEffectiveCoverage(coverage)");

  // A raw `1.0 - coverage` threshold anywhere in the cloud density path is the
  // defect returning.
  assert.doesNotMatch(cloudSource, /smoothstep\(1\.0 - effectiveCoverage/);
  assert.doesNotMatch(iblSource, /smoothstep\(1\.0 - coverage/);
});

test("both composed consumers still compile with the shared response", async () => {
  // The response lives in the chunk that is prepended to BOTH shaders, so a
  // helper that only compiles in one of them is a runtime pipeline failure in
  // the other. Naga is the same validator the cloud lane already trusts.
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
  // C13-10 — validate what a PIPELINE compiles, not the raw file. The march now
  // carries a `//>>ifdef` variant, so its raw text deliberately contains both
  // branches at once and is not valid WGSL on its own. `defaultVariant` is the
  // engine's own preprocessor at `definesHi = 0`, i.e. exactly what every
  // pipeline in this test's scope receives, and it is a no-op for any shader
  // that carries no directives.
  assert.doesNotThrow(() =>
    naga.validate_wgsl(`${domainSource}\n${defaultVariant(cloudSource)}`),
  );
  assert.doesNotThrow(() =>
    naga.validate_wgsl(`${domainSource}\n${defaultVariant(iblSource)}`),
  );
});

test("the response is monotone, clamped, and clear at zero coverage", () => {
  assert.equal(cloudEffectiveCoverage(0), 0);
  assert.equal(cloudEffectiveCoverage(-0.5), 0);
  assert.equal(cloudEffectiveCoverage(1), 1);
  assert.equal(cloudEffectiveCoverage(1.5), 1);

  let previous = -1;
  for (let step = 0; step <= 2000; step++) {
    const coverage = step / 2000;
    const effective = cloudEffectiveCoverage(coverage);
    assert.ok(
      effective >= previous,
      `not monotone at coverage ${coverage}: ${effective} < ${previous}`,
    );
    assert.ok(
      effective >= coverage - 1e-7,
      `below the identity at ${coverage}`,
    );
    assert.ok(effective <= 1, `above 1 at ${coverage}`);
    previous = effective;
  }
});

test("at and above the anchor the response is the historical one, exactly", () => {
  for (const coverage of [
    0.55, 0.5500001, 0.56, 0.6, 0.65, 0.7, 0.75, 0.9, 0.95, 1,
  ]) {
    assert.equal(
      cloudEffectiveCoverage(coverage),
      historicalEffectiveCoverage(coverage),
      `coverage ${coverage} must be bit-identical to the historical response`,
    );
  }
  // ... and strictly lifted below it, or the fix does nothing.
  for (const coverage of [0.1, 0.15, 0.25, 0.35, 0.45, 0.5, 0.54]) {
    assert.ok(
      cloudEffectiveCoverage(coverage) > historicalEffectiveCoverage(coverage),
      `coverage ${coverage} was not lifted`,
    );
  }
});

// ── 3. The rendered response, through the CPU twin of the density field ───

test("the sampled coverages are nonzero from 0.15 and strictly increasing", () => {
  const sweep = SAMPLED.map((coverage) => statsFor(coverage));
  for (const point of sweep) {
    assert.ok(
      point.volumeFraction > 0,
      `coverage ${point.coverage} still renders nothing (${JSON.stringify(point)})`,
    );
    assert.ok(
      point.peakDensity > 0.05,
      `coverage ${point.coverage} peak too low`,
    );
    assert.ok(
      point.skyCover > 0,
      `coverage ${point.coverage} covers no column`,
    );
  }
  for (let i = 1; i < sweep.length; i++) {
    const previous = sweep[i - 1];
    const current = sweep[i];
    assert.ok(
      current.volumeFraction > previous.volumeFraction,
      `volume not increasing ${previous.coverage} -> ${current.coverage}`,
    );
    assert.ok(
      current.skyCover > previous.skyCover,
      `sky cover not increasing ${previous.coverage} -> ${current.coverage}`,
    );
    assert.ok(
      current.peakDensity > previous.peakDensity,
      `peak density not increasing ${previous.coverage} -> ${current.coverage}`,
    );
  }
});

test("0.35 reads as scattered, not as overcast and not as a token puff", () => {
  const anchor = statsFor(CLOUD_COVERAGE_ANCHOR);
  const scattered = statsFor(0.35);
  const sparse = statsFor(0.15);

  // Meteorological "scattered" cannot mean 35% of the sky here: the anchor the
  // acceptance preserves only reaches ~18% sky cover itself, so monotonicity
  // caps 0.35 below that. The contract is that 0.35 lands in the middle of the
  // range the anchor defines — clearly present, clearly broken.
  assert.ok(
    scattered.skyCover > 0.25 * anchor.skyCover,
    `0.35 sky cover ${scattered.skyCover} vs anchor ${anchor.skyCover}`,
  );
  assert.ok(
    scattered.skyCover < 0.75 * anchor.skyCover,
    `0.35 reads closer to the anchor deck than to a scattered field`,
  );
  // Puffs, not haze: the surviving cores keep most of the anchor's density.
  assert.ok(
    scattered.peakDensity > 0.6 * anchor.peakDensity,
    `0.35 peak ${scattered.peakDensity} vs anchor ${anchor.peakDensity}`,
  );
  assert.ok(
    scattered.solidCover < 0.5 * scattered.skyCover + 1e-9,
    "a scattered field cannot be mostly solid overcast",
  );
  // 0.15 is sparser than 0.35 by a clear margin rather than by rounding.
  assert.ok(sparse.skyCover < 0.4 * scattered.skyCover);
});

test("feature preservation: the deck at and above the anchor is unchanged", () => {
  for (const coverage of [0.55, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    assert.deepEqual(
      statsFor(coverage),
      statsFor(coverage, historicalEffectiveCoverage),
      `coverage ${coverage} changed — preservation is exact, not approximate`,
    );
  }
});

test("the negative-space control stays clear", () => {
  // sahara-clear-sky renders at 0.05 behind a ceiling gate; if the response
  // lifts that into visible cloud, the tour's only negative control is gone.
  for (const coverage of [0, 0.02, 0.05]) {
    const stats = statsFor(coverage);
    assert.equal(stats.volumeFraction, 0, `coverage ${coverage} grew cloud`);
    assert.equal(stats.skyCover, 0);
  }
  // The first coverage that renders anything at all is still well clear of it.
  assert.ok(statsFor(0.08).skyCover === 0);
});
