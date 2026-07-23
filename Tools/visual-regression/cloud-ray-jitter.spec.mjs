import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const shaderPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
);
const rendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const tierPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts",
);

const shader = fs.readFileSync(shaderPath, "utf8");
const renderer = fs.readFileSync(rendererPath, "utf8");
const tiers = fs.readFileSync(tierPath, "utf8");

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source anchor: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source anchor: ${end}`);
  return source.slice(startIndex, endIndex);
}

// Model the authored WGSL operation order. JavaScript otherwise evaluates the
// formula as f64 and would overstate the precision available to the shader.
const f32 = Math.fround;
const addF32 = (left, right) => f32(f32(left) + f32(right));
const multiplyF32 = (left, right) => f32(f32(left) * f32(right));
const fractF32 = (value) => {
  const rounded = f32(value);
  return f32(rounded - Math.floor(rounded));
};

function interleavedGradientNoiseF32(pixelX, pixelY, frameIndex) {
  const temporalOffset = multiplyF32(
    5.588238,
    fractF32(multiplyF32(frameIndex, 0.6180339887)),
  );
  const x = addF32(pixelX, temporalOffset);
  const y = addF32(pixelY, temporalOffset);
  const inner = fractF32(
    addF32(multiplyF32(0.06711056, x), multiplyF32(0.00583715, y)),
  );
  return fractF32(multiplyF32(52.9829189, inner));
}

function histogram(values, binCount) {
  const bins = Array(binCount).fill(0);
  for (const value of values) {
    assert.ok(value >= 0 && value < 1, `IGN escaped [0,1): ${value}`);
    bins[Math.min(binCount - 1, Math.floor(value * binCount))]++;
  }
  return bins;
}

test("the f32 IGN field is spatially balanced and temporally decorrelated", () => {
  for (const frameIndex of [0, 1, 15, 16, 63]) {
    const values = [];
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        values.push(interleavedGradientNoiseF32(x, y, frameIndex));
      }
    }

    const mean =
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const bins = histogram(values, 8);
    assert.ok(
      mean >= 0.49 && mean <= 0.51,
      `frame ${frameIndex} spatial mean ${mean} was not balanced`,
    );
    for (const [index, count] of bins.entries()) {
      assert.ok(
        count >= 480 && count <= 544,
        `frame ${frameIndex} bin ${index} contained ${count}, expected near 512`,
      );
    }
  }

  const temporalValues = [...Array(64).keys()].map((frameIndex) =>
    interleavedGradientNoiseF32(37, 19, frameIndex),
  );
  assert.equal(new Set(temporalValues).size, 64);
  assert.ok(Math.min(...temporalValues) < 0.05);
  assert.ok(Math.max(...temporalValues) > 0.95);
  for (const count of histogram(temporalValues, 8)) {
    assert.ok(count >= 4, `a temporal IGN octile contained only ${count} samples`);
  }
});

test("tier intent and renderer wiring carry QF_JITTER without changing the escape route", () => {
  assert.match(tiers, /CLOUD_QF_JITTER\s*=\s*1\s*<<\s*3/);

  const low = sourceSection(
    tiers,
    "// T1 Volumetric-Low",
    "// T2 Volumetric-High",
  );
  const medium = sourceSection(
    tiers,
    "// T2 Volumetric-High",
    "// T3 Cinematic",
  );
  const high = sourceSection(tiers, "// T3 Cinematic", "];");
  const escape = sourceSection(
    tiers,
    "if (typeof raw === \"number\" && raw !== 64)",
    "return CLOUD_TIER_PRESETS",
  );

  for (const [name, preset] of [
    ["low", low],
    ["medium", medium],
    ["high", high],
  ]) {
    assert.match(preset, /jitterEnabled:\s*true/, `${name} must request jitter`);
  }
  assert.match(
    escape,
    /jitterEnabled:\s*false/,
    "the explicit cloudQuality escape must preserve the legacy midpoint",
  );

  assert.match(
    renderer,
    /CLOUD_QF_JITTER/,
    "the renderer must import the tier jitter flag",
  );
  assert.match(
    renderer,
    /const\s+jitterBit\s*=\s*cloudPreset\.jitterEnabled\s*\?\s*CLOUD_QF_JITTER\s*:\s*0/,
    "the renderer must derive QF_JITTER solely from the resolved preset",
  );
  const qualityFlagPack = sourceSection(
    renderer,
    "const noiseBakedBit",
    "// 75",
  );
  assert.match(
    qualityFlagPack,
    /\|\s*jitterBit/,
    "uniform slot 74 must include jitterBit",
  );
});

test("the shader uses pixel-local IGN, a temporal-only animation phase, and an exact midpoint off route", () => {
  assert.match(shader, /const QF_JITTER:\s*u32\s*=\s*8u/);
  assert.match(shader, /fn interleavedGradientNoise\s*\(/);

  const phaseHelper = sourceSection(
    shader,
    "fn cloudRaySamplePhase(",
    "// ─── Full-screen triangle",
  );
  assert.match(phaseHelper, /QF_JITTER/);
  assert.match(phaseHelper, /return 0\.5;/);
  assert.match(
    phaseHelper,
    /QF_TEMPORAL/,
    "frame animation must be gated by realized temporal accumulation",
  );
  assert.match(phaseHelper, /cloud\.frameCounter/);

  const fragment = sourceSection(
    shader,
    "fn fragmentMain(input: VertexOutput)",
    "// ─── TAKRAM-9",
  );
  assert.match(
    fragment,
    /cloudRaySamplePhase\(input\.position\.xy\)/,
    "IGN must use actual render-target pixel coordinates",
  );

  // The off path preserves the exact old arithmetic expression and operation
  // order for representative near, ordinary, and far march intervals.
  for (const [t, step] of [
    [0, 1],
    [700, 52.083332],
    [18_000_000, 4096],
  ]) {
    const oldSample = addF32(t, multiplyF32(0.5, step));
    const offSample = addF32(t, multiplyF32(0.5, step));
    assert.ok(Object.is(offSample, oldSample));
  }
});

test("the shared frame counter keeps 64 IGN phases while preserving Bayer's 16-phase cycle", () => {
  assert.match(
    renderer,
    /cache\.frameCounter\s*=\s*\(cache\.frameCounter\s*\+\s*1\)\s*&\s*63/,
    "the CPU counter must wrap at 64 for exact f32 IGN seeds",
  );
  assert.match(
    shader,
    /let bIndex\s*=\s*u32\(cloud\.frameCounter\)\s*&\s*15u/,
    "Bayer must continue indexing only its low four bits",
  );
  assert.match(shader, /const BAYER4:\s*array<f32,\s*16>/);

  let frameCounter = 0;
  const ignPhases = [];
  const bayerCounts = Array(16).fill(0);
  for (let frame = 0; frame < 64; frame++) {
    frameCounter = (frameCounter + 1) & 63;
    ignPhases.push(frameCounter);
    bayerCounts[frameCounter & 15]++;
  }
  assert.equal(new Set(ignPhases).size, 64);
  assert.deepEqual(bayerCounts, Array(16).fill(4));
  assert.equal(frameCounter, 0);
});

test("jitter changes only the sample phase, preserving adaptive control intervals and the shared base/full position", () => {
  const march = sourceSection(shader, "fn marchDeck(", "fn multiDeckEnabled()");

  assert.match(
    march,
    /marchSamplePhase:\s*f32/,
    "marchDeck must receive one phase computed outside the loop",
  );
  assert.match(march, /var t:\s*f32\s*=\s*tStart;/);
  assert.match(march, /var tProcessed:\s*f32\s*=\s*tStart;/);
  assert.match(
    march,
    /let sampleOffset\s*=\s*rayDir\s*\*\s*\(t\s*\+\s*marchSamplePhase\s*\*\s*curStep\);/,
  );
  assert.match(
    march,
    /let base\s*=\s*cloudBaseDensity\(samplePos,\s*heightFraction,\s*deckBottom,\s*deckTop\);/,
  );
  assert.match(
    march,
    /let density\s*=\s*cloudDensity\(samplePos,\s*heightFraction,\s*deckBottom,\s*deckTop\);/,
  );
  assert.match(march, /t\s*=\s*max\(t\s*-\s*curCoarseStep,\s*tProcessed\);/);
  assert.doesNotMatch(
    march,
    /var t:\s*f32\s*=\s*tStart\s*[+-].*(?:jitter|phase)/i,
    "jitter must not skip the beginning of the shell or move tProcessed",
  );

  // `t + phase * curStep` is evaluated as f32 in WGSL. At horizon/orbit
  // distances a phase below 1 can round onto the same representable value as
  // `t + curStep`. The honest invariant is therefore the closed representable
  // interval [f32(t), f32(t + curStep)], not a fictitious f64 half-open range.
  // These cases keep end > start while covering near, horizon, and orbit-scale
  // march distances.
  const intervals = [
    { t: 0, step: 1 },
    { t: 700, step: 52.083332 },
    { t: 6_378_137, step: 52.083332 },
    { t: 18_000_000, step: 52.083332 },
    { t: 31_000_000, step: 4096 },
    { t: 100_000_000, step: 65_536 },
  ];
  const phases = [
    0,
    0.001,
    0.5,
    0.999999,
    f32(0.99999994),
    ...[...Array(64).keys()].map((frameIndex) =>
      interleavedGradientNoiseF32(37, 19, frameIndex),
    ),
  ];
  let roundedToNextBoundary = 0;
  for (const { t, step } of intervals) {
    const startF32 = f32(t);
    const stepF32 = f32(step);
    const endF32 = addF32(startF32, stepF32);
    assert.ok(
      endF32 > startF32,
      `test interval collapsed at t=${t}, step=${step}`,
    );
    for (const phase of phases) {
      const phaseF32 = f32(phase);
      const sampleF32 = addF32(
        startF32,
        multiplyF32(phaseF32, stepF32),
      );
      assert.ok(
        sampleF32 >= startF32,
        `${sampleF32} preceded f32 interval start ${startF32}`,
      );
      assert.ok(
        sampleF32 <= endF32,
        `${sampleF32} escaped representable interval [${startF32}, ${endF32}]`,
      );
      if (phaseF32 < 1 && sampleF32 === endF32) {
        roundedToNextBoundary++;
      }
    }
  }
  assert.ok(
    roundedToNextBoundary > 0,
    "extreme cases must exercise legal f32 rounding onto the next boundary",
  );
});

test("the complete procedural-cloud shader passes Naga WGSL validation", async () => {
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
  assert.doesNotThrow(() => naga.validate_wgsl(shader));
});
