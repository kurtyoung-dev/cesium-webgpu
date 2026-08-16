// RUNNER REQUIREMENT: Node >= 22.18. This spec's model imports a `.ts` module
// (WebGPUCloudDensityDomain.ts) and relies on Node's built-in type stripping,
// which is on by default only from 22.18 onward; on 22.6-22.17 add
// `--experimental-strip-types`.
// @purpose Pins the fog cheap-path cloud-shadow coverage gate: samples standardised onto the baked field's moments, with mutants and byte-neutrality.
// @status ACTIVE
//
// CLOUD-LOW-COVERAGE-CUTOFF — THE FOG CHEAP-PATH ARM.
//
// The volumetric fog's CHEAP (non-hi-fi) cloud shadow approximates the visible
// cloud deck with its own local 3-octave value fBM and gates it on cloud
// coverage. When `cloudEffectiveCoverage` re-derived the coverage response for
// the visible march and the IBL cube, this gate was left reading the RAW
// `1.0 - coverage` threshold. It was the last raw threshold in the
// cloud-density family.
//
// Routing it through the shared response is necessary but NOT sufficient, and
// that is the finding this file exists to pin: a coverage threshold is only
// transferable between two density fields when the fields share a
// distribution. They do not. The baked shape channel is a narrow near-Gaussian
// centred well below 0.5; the fog's local field is symmetric about 0.5 by
// construction and about 35% wider. So the fix STANDARDISES the fog sample
// onto the baked field's first two moments and then applies the shared
// response unmodified.
//
// What is pinned here:
//
//   1. the ROOT CAUSE as a checkable fact about the two real fields, measured
//      with the shipped arithmetic, not as prose;
//   2. the historical gate reproduced and shown to BE the defect, in both
//      directions (too little shadow when fair, too much when scattered);
//   3. the shipped gate's SUPPORT tracking the visible march's, and its
//      smoothstep RAMP tracking it too — the ramp is why the sample is
//      normalised instead of the threshold being moved;
//   4. MUTATION: four separate ways to un-fix it, each required to be caught
//      by the same measurement that passes the shipped tree;
//   5. the WGSL and its CPU twin pinned as one definition, and the composition
//      that gives the fog module access to the shared response;
//   6. byte-neutrality of every path that does not reach the gate, with
//      `assert.equal` and no tolerances.
//
// MEASUREMENT TRAP (recorded for this subsystem): faint wide-band changes are
// invisible to band-mean statistics. Every metric here is banded (exceedance
// of a threshold) or a point metric (the gate evaluated at one order
// statistic) — never a field mean.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CLOUD_SHAPE_FIELD_MEAN,
  FOG_CHEAP_FIELD_MEAN,
  FOG_CHEAP_FIELD_SIGMA_RATIO,
  SWEEP_COVERAGES,
  cloudEffectiveCoverage,
  gateAmplitudeAtQuantiles,
  gateTrackingSweep,
  historicalResponse,
  identityNormalization,
  normalizeFogCheapCloudField,
  sampleBakedShapeField,
  sampleFogCheapField,
  summarize,
  worstTrackingError,
} from "./lib/fog-cheap-coverage-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
// Line endings are normalised because this repository checks these files out
// with CRLF on Windows; the structural assertions below are about code shape,
// never about which line terminator the working tree happens to carry.
const read = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const FOG_WGSL =
  "packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl";
const DOMAIN_WGSL =
  "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.wgsl";
const RESOURCES_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogResources.ts";
const TWIN_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts";

const fogSource = read(FOG_WGSL);
const domainSource = read(DOMAIN_WGSL);
const resourcesSource = read(RESOURCES_TS);
const twinSource = read(TWIN_TS);

// One build of each field serves every case in this file.
const fields = {
  fog: summarize(sampleFogCheapField()),
  cloud: summarize(sampleBakedShapeField()),
};

// The shipped gate must track the visible march this closely, and every mutant
// must miss by at least this much. The gap between the two is the margin.
const TRACKING_CONTRACT = 0.02;
const MUTANT_FLOOR = 0.05;

// ── 1. Root cause, as a checkable fact about the two real fields ───────────

test("the two density fields do not share a distribution", () => {
  // If they did, one threshold would serve both and there would be no defect.
  const meanGap = fields.fog.mean - fields.cloud.mean;
  assert.ok(
    meanGap > 0.05,
    `fog mean ${fields.fog.mean} vs baked ${fields.cloud.mean} — the gap that ` +
      `makes a shared raw threshold wrong has closed`,
  );
  const sigmaRatio = fields.fog.sigma / fields.cloud.sigma;
  assert.ok(
    sigmaRatio > 1.2,
    `sigma ratio ${sigmaRatio} — the fog field is expected to be materially wider`,
  );

  // The fog field is symmetric about 0.5 by construction (a value fBM of
  // uniform hashes); the baked one is not. That asymmetry is the whole story.
  assert.ok(Math.abs(fields.fog.mean - 0.5) < 0.005, `${fields.fog.mean}`);
  assert.ok(fields.cloud.mean < 0.47, `${fields.cloud.mean}`);

  // And the fog field reaches much further into the upper tail, which is why
  // the raw gate over-admits once the threshold drops into its bulk.
  assert.ok(fields.fog.max > 0.85, `fog max ${fields.fog.max}`);
  assert.ok(fields.cloud.max < 0.75, `baked max ${fields.cloud.max}`);
});

test("the constants the engine ships are the measured ones", () => {
  // Derived, not tuned: each shipped constant must reproduce what sampling the
  // real field with the shipped arithmetic actually finds.
  assert.ok(
    Math.abs(CLOUD_SHAPE_FIELD_MEAN - fields.cloud.mean) < 0.005,
    `shipped ${CLOUD_SHAPE_FIELD_MEAN} vs measured ${fields.cloud.mean}`,
  );
  assert.ok(
    Math.abs(FOG_CHEAP_FIELD_MEAN - fields.fog.mean) < 0.005,
    `shipped ${FOG_CHEAP_FIELD_MEAN} vs measured ${fields.fog.mean}`,
  );
  const measuredRatio = fields.fog.sigma / fields.cloud.sigma;
  assert.ok(
    Math.abs(FOG_CHEAP_FIELD_SIGMA_RATIO - measuredRatio) < 0.02,
    `shipped ${FOG_CHEAP_FIELD_SIGMA_RATIO} vs measured ${measuredRatio}`,
  );
  // The mean is the structural value, not a fit, so it is exact.
  assert.equal(FOG_CHEAP_FIELD_MEAN, 0.5);
});

// ── 2. The historical gate, reproduced, and shown to be the defect ─────────

test("the historical raw gate mistracks the visible deck in both directions", () => {
  const sweep = gateTrackingSweep(fields, {
    normalize: identityNormalization,
    response: historicalResponse,
  });
  const worst = worstTrackingError(sweep);
  assert.ok(
    worst > 0.2,
    `historical worst tracking error ${worst} — this file's premise is that it ` +
      `was catastrophic, not marginal`,
  );

  const at = (coverage) => sweep.find((row) => row.coverage === coverage);

  // Fair weather: the fog cast almost no shadow under a visibly clouded sky.
  const fair = at(0.15);
  assert.ok(
    fair.fogAdmitted < 0.2 * fair.cloudAdmitted,
    `0.15 fog ${fair.fogAdmitted} vs deck ${fair.cloudAdmitted}`,
  );
  // Scattered/broken: it cast a near-overcast one.
  const anchor = at(0.55);
  assert.ok(
    anchor.fogAdmitted > 1.3 * anchor.cloudAdmitted,
    `0.55 fog ${anchor.fogAdmitted} vs deck ${anchor.cloudAdmitted}`,
  );
});

test("routing through the shared response alone would NOT have fixed it", () => {
  // The obvious one-line fix — swap `coverage` for `cloudEffectiveCoverage(
  // coverage)` and leave the sample alone — is worse than doing nothing at the
  // sparse end, because the lifted threshold lands inside this field's bulk.
  const sweep = gateTrackingSweep(fields, { normalize: identityNormalization });
  const worst = worstTrackingError(sweep);
  assert.ok(
    worst > 0.2,
    `response-only worst tracking error ${worst} — the normalisation is ` +
      `load-bearing and this is what proves it`,
  );
});

// ── 3. The shipped gate: support AND ramp ─────────────────────────────────

test("the shipped gate admits the same fraction of deck as the visible march", () => {
  const sweep = gateTrackingSweep(fields);
  const worst = worstTrackingError(sweep);
  assert.ok(
    worst <= TRACKING_CONTRACT,
    `worst tracking error ${worst} exceeds ${TRACKING_CONTRACT}:\n` +
      sweep
        .map(
          (row) =>
            `  c=${row.coverage} deck=${row.cloudAdmitted.toFixed(4)} ` +
            `fog=${row.fogAdmitted.toFixed(4)}`,
        )
        .join("\n"),
  );
  assert.equal(sweep.length, SWEEP_COVERAGES.length);
});

test("the shipped gate's threshold is strictly monotone in coverage", () => {
  const sweep = gateTrackingSweep(fields);
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(
      sweep[i].fogThreshold < sweep[i - 1].fogThreshold,
      `threshold not decreasing ${sweep[i - 1].coverage} -> ${sweep[i].coverage}`,
    );
  }
  // Denser sweep on the response itself: more coverage can never admit less.
  let previous = Infinity;
  for (let step = 1; step <= 1000; step++) {
    const coverage = step / 1000;
    const threshold = 1 - cloudEffectiveCoverage(coverage);
    assert.ok(threshold <= previous + 1e-7, `not monotone at ${coverage}`);
    previous = threshold;
  }
});

test("the smoothstep RAMP tracks too, not just the support", () => {
  // This is why the SAMPLE is normalised rather than the THRESHOLD moved: an
  // equivalent threshold shift would match the support and leave the ramp
  // width wrong, so the same fraction of deck would shadow at the wrong
  // density. Point metrics — the gate evaluated at fixed order statistics.
  const normalizedFog = {
    quantile: (p) => normalizeFogCheapCloudField(fields.fog.quantile(p)),
  };
  for (const coverage of [0.35, 0.55, 0.8]) {
    const threshold = Math.fround(1 - cloudEffectiveCoverage(coverage));
    const deck = gateAmplitudeAtQuantiles(fields.cloud, threshold);
    const fog = gateAmplitudeAtQuantiles(normalizedFog, threshold);
    const historical = gateAmplitudeAtQuantiles(
      fields.fog,
      Math.fround(1 - coverage),
    );
    for (let i = 0; i < deck.length; i++) {
      assert.ok(
        Math.abs(deck[i] - fog[i]) < 0.03,
        `coverage ${coverage} quantile ${i}: deck ${deck[i]} vs fog ${fog[i]}`,
      );
    }
    // ... and the historical ramp did not, or there was nothing to fix.
    const historicalWorst = Math.max(
      ...deck.map((value, i) => Math.abs(value - historical[i])),
    );
    assert.ok(
      historicalWorst > 0.1,
      `coverage ${coverage}: historical ramp error ${historicalWorst}`,
    );
  }
});

test("a clear sky stays clear and an overcast one stays overcast", () => {
  const sweep = gateTrackingSweep(fields);
  const at = (coverage) => sweep.find((row) => row.coverage === coverage);
  // The negative-space control the cloud tour depends on: 0.05 must not grow
  // fog shadow just because the low end was lifted.
  assert.ok(at(0.05).fogAdmitted < 0.002, `${at(0.05).fogAdmitted}`);
  // The shader's own short-circuit keeps the gate away from smoothstep's
  // degenerate `edge0 == edge1`, so an exactly-zero coverage never reaches it.
  assert.match(
    fogSource,
    /if \(coverage <= 1e-3\) \{\n {4}return 1\.0;\n {2}\}/,
  );
  // Full coverage still shadows everything.
  assert.equal(at(1).fogAdmitted, 1);
  assert.equal(at(1).cloudAdmitted, 1);
});

// ── 4. MUTATION — four ways to un-fix it, all required to be caught ────────

test("MUTATION: each way of re-introducing the defect is detected", () => {
  const mutants = [
    {
      name: "the historical raw gate (the original defect)",
      options: {
        normalize: identityNormalization,
        response: historicalResponse,
      },
    },
    {
      name: "shared response, but the normalisation deleted",
      options: { normalize: identityNormalization },
    },
    {
      name: "normalisation kept, but the shared response reverted",
      options: { response: historicalResponse },
    },
    {
      name: "the sigma ratio flattened to 1 (mean-shift only)",
      options: {
        normalize: (value) =>
          Math.fround(CLOUD_SHAPE_FIELD_MEAN + (value - FOG_CHEAP_FIELD_MEAN)),
      },
    },
  ];

  for (const mutant of mutants) {
    const worst = worstTrackingError(gateTrackingSweep(fields, mutant.options));
    assert.ok(
      worst > MUTANT_FLOOR,
      `MUTANT NOT DETECTED — "${mutant.name}" scored ${worst}, which the ` +
        `contract (${TRACKING_CONTRACT}) would have accepted. The measurement ` +
        `is not sensitive enough to protect the fix.`,
    );
  }

  // The clean tree must sit on the other side of the same measurement, or the
  // mutants above prove nothing.
  assert.ok(worstTrackingError(gateTrackingSweep(fields)) <= TRACKING_CONTRACT);
});

// ── 5. One definition: WGSL, its CPU twin, and the composition ────────────

test("the WGSL gate routes through the shared response and the normalisation", () => {
  const gates = [...fogSource.matchAll(/smoothstep\(\s*1\.0 - ([^,]+),/g)];
  assert.equal(gates.length, 1, "the fog has exactly one coverage gate");
  assert.equal(gates[0][1].trim(), "cloudEffectiveCoverage(coverage)");
  assert.match(fogSource, /normalizeFogCheapCloudField\(n\)\s*\n?\s*\);/);

  // A raw `1.0 - coverage` threshold anywhere in this shader is the defect
  // returning. This is the assertion `cloud-coverage-response.spec.mjs` makes
  // for the march and the IBL cube; the fog was the file it did not cover.
  assert.doesNotMatch(fogSource, /smoothstep\(1\.0 - coverage/);

  // The normalisation is applied exactly once, at the gate — not sprinkled.
  assert.equal(
    fogSource.split("normalizeFogCheapCloudField(").length - 1,
    2, // the declaration plus the single call site
  );
});

test("the WGSL constants and the CPU twin are one definition", () => {
  assert.match(fogSource, /const CLOUD_SHAPE_FIELD_MEAN: f32 = 0\.4307;/);
  assert.match(fogSource, /const FOG_CHEAP_FIELD_MEAN: f32 = 0\.5;/);
  assert.match(fogSource, /const FOG_CHEAP_FIELD_SIGMA_RATIO: f32 = 1\.3459;/);
  assert.equal(CLOUD_SHAPE_FIELD_MEAN, 0.4307);
  assert.equal(FOG_CHEAP_FIELD_MEAN, 0.5);
  assert.equal(FOG_CHEAP_FIELD_SIGMA_RATIO, 1.3459);

  // Same spelling in both, so the f32 rounding sequence matches.
  assert.match(
    fogSource,
    /CLOUD_SHAPE_FIELD_MEAN \+\n\s*\(value - FOG_CHEAP_FIELD_MEAN\) \/ FOG_CHEAP_FIELD_SIGMA_RATIO;/,
  );
  assert.match(twinSource, /export function normalizeFogCheapCloudField/);
  assert.match(
    twinSource,
    /export const FOG_CHEAP_FIELD_SIGMA_RATIO = 1\.3459;/,
  );

  // The twin's fixed point is exact, not approximate: the field mean maps to
  // the baked field mean with no tolerance.
  assert.equal(
    normalizeFogCheapCloudField(FOG_CHEAP_FIELD_MEAN),
    Math.fround(CLOUD_SHAPE_FIELD_MEAN),
  );
  // Unclamped, exactly like the shader — `smoothstep` clamps its own
  // interpolant and clamping here would fold the tails the match preserves.
  assert.ok(normalizeFogCheapCloudField(1) > 0.7);
  assert.ok(normalizeFogCheapCloudField(0) < 0.1);
  assert.doesNotMatch(
    twinSource,
    /normalizeFogCheapCloudField[\s\S]{0,700}?Math\.min\(/,
  );
});

test("the fog compute module is composed with the shared domain chunk", () => {
  // `cloudEffectiveCoverage` lives in one place. The fog module gets it the
  // same way the visible march and the IBL cube do.
  assert.match(
    resourcesSource,
    /import CloudDensityDomainWGSL from "\.\.\/\.\.\/Shaders\/WebGPU\/Environment\/CloudDensityDomain\.js";/,
  );
  assert.match(
    resourcesSource,
    /const VOLUMETRIC_FOG_COMPUTE_SOURCE = `\$\{CloudDensityDomainWGSL\}\\n\$\{VolumetricFogComputeSource\}`;/,
  );
  // ... and the composed string, not the bare one, is what reaches the cache.
  assert.match(
    resourcesSource,
    /ShaderSourceId\.VOLUMETRIC_FOG_COMPUTE,\n\s*VOLUMETRIC_FOG_COMPUTE_SOURCE,/,
  );

  // Composed at module scope: `WebGPUShaderModuleCache` keys on
  // `(sourceId, defines)` and never on the source text, so one source ID must
  // always mean one string. A per-call template would still be correct today
  // but would make that invariant depend on the caller.
  const compositionIndex = resourcesSource.indexOf(
    "const VOLUMETRIC_FOG_COMPUTE_SOURCE",
  );
  const builderIndex = resourcesSource.indexOf(
    "export function buildVolumetricFogResources",
  );
  assert.ok(compositionIndex > 0 && compositionIndex < builderIndex);

  // The chunk must stay binding-free or prepending it would fork the fog's
  // bind-group layouts.
  assert.doesNotMatch(
    domainSource,
    /@group|@binding|textureSample|textureStore/,
  );
});

test("the composed source validates under naga, and the bare one does not", () => {
  // The second half is what proves the composition is load-bearing rather than
  // decorative: if the fog shader still validated alone, the gate would not be
  // reading the shared definition.
  return (async () => {
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
    assert.doesNotThrow(() =>
      naga.validate_wgsl(`${domainSource}\n${fogSource}`),
    );
    assert.throws(
      () => naga.validate_wgsl(fogSource),
      /cloudEffectiveCoverage/,
    );
  })();
});

// ── 6. Byte-neutrality of every path that does not reach the gate ─────────

test("no path that skips the gate can observe the change", () => {
  const body = fogSource.slice(
    fogSource.indexOf("fn sampleCloudShadow("),
    fogSource.indexOf("// ─────", fogSource.indexOf("fn sampleCloudShadow(")),
  );

  // The three early returns that stand between a frame and this gate, in the
  // order they must keep. Exact text, no tolerances.
  const hiFi = body.indexOf("if (u.cloudShadowHiFi.x >= 0.5) {");
  const enable = body.indexOf("if (cloudShadowEnable < 0.5) {");
  const epsilon = body.indexOf("if (coverage <= 1e-3) {");
  const gate = body.indexOf("cloudEffectiveCoverage(coverage)");
  assert.ok(hiFi > 0 && enable > hiFi && epsilon > enable && gate > epsilon);

  assert.match(
    body,
    /let cloudShadowEnable = u\.cloudShadow\.x;\n {2}if \(cloudShadowEnable < 0\.5\) \{\n {4}return 1\.0;\n {2}\}/,
  );

  // The hi-fi path samples the real beer shadow map and returns before the
  // cheap field is ever built, so it is untouched.
  const hiFiBranch = body.slice(hiFi, enable);
  assert.doesNotMatch(hiFiBranch, /normalizeFogCheapCloudField|fbm3d/);

  // Nothing outside `sampleCloudShadow` changed shape: the normalisation is
  // not referenced by the density, scattering, integrate, or temporal kernels.
  const afterBody = fogSource.slice(fogSource.indexOf("@compute"));
  assert.doesNotMatch(afterBody, /normalizeFogCheapCloudField/);
});

test("the fog's cloud-shadow enable predicate is unchanged", () => {
  // The renderer-side gate that makes "no volumetric clouds" byte-identical.
  const rendererSource = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts",
  );
  assert.match(
    rendererSource,
    /const cloudsEnabled =\n\s*volColl\?\.renderMode === 1 &&\n\s*vol\?\.enabled === true &&\n\s*\(vol\?\.cloudCoverage \?\? 0\) > 0;/,
  );
  assert.match(rendererSource, /r\.paramsData\[72\] = cloudShadowEnable;/);
});
