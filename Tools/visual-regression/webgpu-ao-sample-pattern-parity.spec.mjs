/* eslint-disable no-regex-spaces -- the patterns below match WGSL source indentation verbatim */
// Pure Node (`node --test`). No shader compilation or GPU device is required.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function read(relative) {
  return fs
    .readFileSync(path.join(REPO_ROOT, relative), "utf8")
    .replace(/\r\n/g, "\n");
}

const WGSL_F32 = read(
  "packages/engine/Source/Shaders/WebGPU/PostProcess/AmbientOcclusionGenerate.wgsl",
);
const WGSL_F16 = read(
  "packages/engine/Source/Shaders/WebGPU/PostProcess/AmbientOcclusionGenerate_f16.wgsl",
);
const GLSL = read(
  "packages/engine/Source/Shaders/PostProcessStages/AmbientOcclusionGenerate.glsl",
);

const CASES = [
  { directionCount: 8, stepCount: 32 },
  { directionCount: 16, stepCount: 32 },
  { directionCount: 4, stepCount: 16 },
];

function requiredMatch(source, expression, label) {
  const match = source.match(expression);
  assert.ok(match, `${label}: missing ${expression}`);
  return match;
}

function resolveCountExpression(expression, counts, label) {
  if (expression === "directionCount" || expression === "stepCount") {
    return counts[expression];
  }

  const clamp = expression.match(
    /^min\((directionCount|stepCount), ([0-9]+)\)$/,
  );
  assert.ok(clamp, `${label}: unsupported count expression ${expression}`);
  return Math.min(counts[clamp[1]], Number(clamp[2]));
}

function extractWgslPattern(source, label) {
  requiredMatch(
    source,
    /^  let fullSamplePattern = uniforms\._pad\.x > 0\.5;$/m,
    label,
  );
  requiredMatch(source, /^  if \(!fullSamplePattern\) \{$/m, label);
  requiredMatch(
    source,
    /^    executedDirectionCount = min\(directionCount, 8\);$/m,
    label,
  );
  requiredMatch(
    source,
    /^    executedStepCount = min\(stepCount, 16\);$/m,
    label,
  );

  const directionLoop = requiredMatch(
    source,
    /^  for \(var d: i32 = 0; d < ([A-Za-z]\w*); d = d \+ 1\) \{$/m,
    label,
  );
  const stepLoop = requiredMatch(
    source,
    /^    for \(var s: i32 = 1; s <= ([A-Za-z]\w*); s = s \+ 1\) \{$/m,
    label,
  );

  const directionInitializer = requiredMatch(
    source,
    new RegExp(`^  var ${directionLoop[1]} = (.+);$`, "m"),
    label,
  )[1];
  const stepInitializer = requiredMatch(
    source,
    new RegExp(`^  var ${stepLoop[1]} = (.+);$`, "m"),
    label,
  )[1];

  const divisor = requiredMatch(
    source,
    /^  let executedSampleCount = ([A-Za-z]\w*) \* ([A-Za-z]\w*);$/m,
    label,
  );
  assert.equal(divisor[1], directionLoop[1], `${label}: divisor direction`);
  assert.equal(divisor[2], stepLoop[1], `${label}: divisor step`);

  const f32Divisor = "    ao = ao / f32(executedSampleCount);";
  const f16Divisor = "    ao = f16(f32(ao) / f32(executedSampleCount));";
  assert.ok(
    source.split("\n").includes(f32Divisor) ||
      source.split("\n").includes(f16Divisor),
    `${label}: full branch does not divide by executedSampleCount`,
  );

  return {
    label,
    executed(counts) {
      const directions = resolveCountExpression(
        directionInitializer,
        counts,
        label,
      );
      const steps = resolveCountExpression(stepInitializer, counts, label);
      return directions * steps;
    },
    divisor(counts) {
      const directions = resolveCountExpression(
        directionInitializer,
        counts,
        label,
      );
      const steps = resolveCountExpression(stepInitializer, counts, label);
      return directions * steps;
    },
  };
}

function extractGlslPattern(source) {
  const directionLoop = requiredMatch(
    source,
    /#if __VERSION__ == 300\n    for \(int i = 0; i < ([A-Za-z]\w*); i\+\+\)/,
    "GLSL",
  );
  const stepLoop = requiredMatch(
    source,
    /#if __VERSION__ == 300\n        for \(int j = 0; j < ([A-Za-z]\w*); j\+\+\)/,
    "GLSL",
  );
  const directionNormalizer = requiredMatch(
    source,
    /^    float angleStepScale = 1\.0 \/ float\(([A-Za-z]\w*)\);$/m,
    "GLSL",
  );
  const stepNormalizer = requiredMatch(
    source,
    /^    float stepLength = 3\.0 \* gaussianVariance \/ \(float\(([A-Za-z]\w*)\) \+ 1\.0\);$/m,
    "GLSL",
  );

  assert.equal(directionLoop[1], "directionCount");
  assert.equal(stepLoop[1], "stepCount");
  assert.equal(directionNormalizer[1], directionLoop[1]);
  assert.equal(stepNormalizer[1], stepLoop[1]);

  // GLSL has no sample-count quotient. Its dynamic WebGL2 loop-bound product
  // is the reference divisor that the WGSL average must use.
  return {
    label: "GLSL",
    executed(counts) {
      return counts[directionLoop[1]] * counts[stepLoop[1]];
    },
    divisor(counts) {
      return counts[directionLoop[1]] * counts[stepLoop[1]];
    },
  };
}

function assertPattern(pattern) {
  for (const counts of CASES) {
    const expected = counts.directionCount * counts.stepCount;
    const executed = pattern.executed(counts);
    assert.equal(
      executed,
      expected,
      `${pattern.label} executes ${counts.directionCount}x${counts.stepCount}`,
    );
    assert.equal(
      pattern.divisor(counts),
      executed,
      `${pattern.label} divisor matches executed samples`,
    );
  }
}

test("WebGPU HBAO sample pattern matches the WebGL2 twin", async (t) => {
  await t.test("f32, f16, and GLSL execute and normalize d*s samples", () => {
    for (const pattern of [
      extractWgslPattern(WGSL_F32, "WGSL f32"),
      extractWgslPattern(WGSL_F16, "WGSL f16"),
      extractGlslPattern(GLSL),
    ]) {
      assertPattern(pattern);
    }
  });

  await t.test("clamp mutant makes the parity assertion fail", () => {
    const liveInitializers = [
      "  var executedDirectionCount = directionCount;",
      "  var executedStepCount = stepCount;",
    ].join("\n");
    const clampedInitializers = [
      "  var executedDirectionCount = min(directionCount, 8);",
      "  var executedStepCount = min(stepCount, 16);",
    ].join("\n");
    const mutant = WGSL_F32.replace(liveInitializers, clampedInitializers);
    assert.notEqual(mutant, WGSL_F32, "clamp mutant was not applied");

    assert.throws(
      () => assertPattern(extractWgslPattern(mutant, "WGSL clamp mutant")),
      assert.AssertionError,
      "restoring unconditional 8x16 clamps must fail parity",
    );
  });
});
