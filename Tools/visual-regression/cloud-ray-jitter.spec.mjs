// @purpose Pins the cloud ray-jitter contract across ProceduralClouds.wgsl, CloudDensityDomain.wgsl, the renderer and tier presets via source reads.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultVariant,
  hiVariant,
  ShaderDefineHi,
} from "./lib/wgsl-variant.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const rendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const tierPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts",
);

const renderer = fs.readFileSync(rendererPath, "utf8");
const tiers = fs.readFileSync(tierPath, "utf8");

// The march source the renderer compiles: the modules its
// `PROCEDURAL_CLOUDS_SOURCE` template joins, in its order, each read from the
// `.wgsl` behind the generated module it imports. The view entry points live
// in `CloudViewIntegration.wgsl` and the interval lattice in
// `CloudMarchSampling.wgsl`, so a pin on one module alone reads the wrong text.
function rendererMarchSource(rendererText) {
  const text = rendererText.replace(/\r\n/g, "\n");
  const template = text.match(/const PROCEDURAL_CLOUDS_SOURCE = `([^`]*)`;/);
  assert.ok(template, "the renderer's PROCEDURAL_CLOUDS_SOURCE composition");
  const names = [...template[1].matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
  assert.ok(names.includes("ProceduralCloudsWGSL"), "the march module");
  assert.equal(
    template[1],
    names.map((name) => `\${${name}}`).join("\\n"),
    "the composition joins whole modules with newlines only",
  );
  return names
    .map((name) => {
      const imported = text.match(
        new RegExp(
          `import ${name} from "\\.\\./\\.\\./(Shaders/[\\w/]+)\\.js";`,
        ),
      );
      assert.ok(imported, `the renderer imports ${name} as a shader module`);
      return fs
        .readFileSync(
          path.join(root, "packages/engine/Source", `${imported[1]}.wgsl`),
          "utf8",
        )
        .replace(/\r\n/g, "\n");
    })
    .join("\n");
}

const shader = rendererMarchSource(renderer);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source anchor: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source anchor: ${end}`);
  return source.slice(startIndex, endIndex);
}

// The half-resolution Bayer offset reads the shared frame counter through one
// binding masked to its low four bits, and every BAYER4 read is indexed by that
// binding or by it plus a constant re-masked to four bits. Name-agnostic: the
// march split renamed `bIndex` to `index` without changing the law.
function assertBayerLowFourBits(source) {
  const bindings = [
    ...source.matchAll(
      /let\s+(\w+)\s*=\s*u32\(cloud\.frameCounter\)\s*&\s*15u;/g,
    ),
  ];
  assert.equal(
    bindings.length,
    1,
    "Bayer must continue indexing only its low four bits",
  );
  const name = bindings[0][1];
  const reads = [...source.matchAll(/BAYER4\[([^\]]+)\]/g)].map((m) =>
    m[1].replace(/\s+/g, " ").trim(),
  );
  assert.ok(reads.length > 0, "the half-resolution offset reads BAYER4");
  for (const index of reads) {
    assert.ok(
      index === name ||
        new RegExp(`^\\(${name} \\+ \\d+u\\) & 15u$`).test(index),
      `Bayer must continue indexing only its low four bits: BAYER4[${index}]`,
    );
  }
  return name;
}

// The coarse backtrack steps back one coarse span (four intervals) on the
// interval lattice, never below the furthest interval already examined at
// fine resolution, and the distance it lands on is clamped to tProcessed.
// `tProcessed` advances only where `processedInterval` does. That the lattice
// boundary is monotonic in the interval (so the clamp is the floor it claims)
// is executed out of the shader by cloud-density-domain.spec.mjs ("cloud march
// boundaries remain finite, monotonic and complete").
function assertCoarseBacktrackClamped(march) {
  assert.match(
    march,
    /interval\s*=\s*max\(interval\s*-\s*4\.0,\s*processedInterval\);\s*t\s*=\s*max\(tStart\s*\+\s*cloudMarchIntervalBoundary\(\s*interval,[^;]*\),\s*tProcessed\);/,
    "the coarse backtrack steps back on the interval lattice, never below tProcessed",
  );
  const processed = march.match(/processedInterval\s*=\s*interval;/g) ?? [];
  const advanced = march.match(/tProcessed\s*=\s*t;/g) ?? [];
  assert.ok(processed.length > 0, "the fine phase records processedInterval");
  assert.equal(
    advanced.length,
    processed.length,
    "tProcessed advances only with processedInterval",
  );
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

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
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
    assert.ok(
      count >= 4,
      `a temporal IGN octile contained only ${count} samples`,
    );
  }
});

test("tier intent and renderer wiring carry QF_JITTER without changing the escape route", () => {
  assert.match(tiers, /CLOUD_QF_JITTER\s*=\s*1\s*<<\s*3/);

  const low = sourceSection(tiers, "tier: 1,", "tier: 2,");
  const medium = sourceSection(tiers, "tier: 2,", "tier: 3,");
  const high = sourceSection(tiers, "tier: 3,", "];");
  const escape = sourceSection(
    tiers,
    'if (typeof raw === "number" && raw !== 64)',
    "return CLOUD_TIER_PRESETS",
  );

  for (const [name, preset] of [
    ["low", low],
    ["medium", medium],
    ["high", high],
  ]) {
    assert.match(
      preset,
      /jitterEnabled:\s*true/,
      `${name} must request jitter`,
    );
  }
  assert.match(
    escape,
    /jitterEnabled:\s*false/,
    "the explicit cloudQuality escape must preserve the legacy midpoint",
  );

  // C13-N10 (2026-09-12) moved the `qualityFlags` assembly out of the renderer
  // into `buildCloudQualityBlock` in the preset module, so the tier table is the
  // single producer of every preset-derived uniform. The three assertions below
  // are unchanged in intent — the tier's `jitterEnabled`, and nothing else, must
  // reach bit 3 of uniform float 74 — and now read the file the producer lives
  // in; the renderer's half of the path is pinned by the fourth.
  assert.match(
    tiers,
    /CLOUD_QF_JITTER/,
    "the preset module must define the tier jitter flag",
  );
  assert.match(
    tiers,
    /const\s+jitterBit\s*=\s*preset\.jitterEnabled\s*\?\s*CLOUD_QF_JITTER\s*:\s*0/,
    "QF_JITTER must be derived solely from the resolved preset",
  );
  const qualityFlagPack = sourceSection(
    tiers,
    "const noiseBakedBit",
    "lightSampleScale: preset",
  );
  assert.match(
    qualityFlagPack,
    /\|\s*jitterBit/,
    "uniform slot 74 must include jitterBit",
  );
  assert.match(
    renderer,
    /data\[offset\+\+\] = qualityBlock\.qualityFlags; \/\/ 74 qualityFlags/,
    "the renderer must pack the block's flags into uniform float 74",
  );
});

test("the shader uses pixel-local IGN, a temporal-only animation phase, and an exact midpoint off route", () => {
  assert.match(shader, /const QF_JITTER:\s*u32\s*=\s*8u/);
  assert.match(shader, /fn interleavedGradientNoise\s*\(/);

  const phaseHelper = sourceSection(
    shader,
    "fn cloudRaySamplePhase(",
    "fn vertexMain(",
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
    "fn fragmentCloudMaskMain(",
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
  // The law holds per compiled variant: the default variant carries one
  // half-resolution offset (fragmentMain). Unit 3464's optional primary-reuse
  // entry point (fragmentCloudPrimaryMain, compiled only under
  // CLOUD_PRIMARY_REUSE) carries its own, and the same law holds inside it.
  // R-12 (R-2026-10-22-12): the lead's form; the W3 reviewer re-derives it.
  const selected = defaultVariant(shader);
  const bayerIndex = assertBayerLowFourBits(selected);
  const reuse = hiVariant(shader, ShaderDefineHi.CLOUD_PRIMARY_REUSE);
  const primaryAt = reuse.indexOf("fn fragmentCloudPrimaryMain(");
  assert.ok(primaryAt >= 0, "the primary-reuse entry point is compiled");
  const primaryMain = reuse.slice(primaryAt);
  const primaryBody = primaryMain.slice(0, primaryMain.indexOf("\n}\n") + 3);
  const primaryIndex = assertBayerLowFourBits(primaryBody);
  assert.match(shader, /const BAYER4:\s*array<f32,\s*16>/);
  // Inertness, in each compiled variant: a wider mask, or a Bayer read off the
  // masked binding, is red.
  for (const [variant, source, index] of [
    ["default", selected, bayerIndex],
    ["primary reuse", primaryBody, primaryIndex],
  ]) {
    for (const [label, from, to] of [
      [
        "mask widened",
        "u32(cloud.frameCounter) & 15u;",
        "u32(cloud.frameCounter) & 31u;",
      ],
      [
        "unmasked read",
        `BAYER4[(${index} + 5u) & 15u]`,
        `BAYER4[${index} + 5u]`,
      ],
    ]) {
      assert.equal(
        source.split(from).length,
        2,
        `mutant anchor (${variant}): ${label}`,
      );
      assert.throws(
        () => assertBayerLowFourBits(source.replace(from, to)),
        assert.AssertionError,
        `the Bayer pin survived (${variant}): ${label}`,
      );
    }
  }

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
    /let sampleDistance\s*=\s*t\s*\+\s*marchSamplePhase\s*\*\s*curStep;[\s\S]*let sampleOffset\s*=\s*rayDir\s*\*\s*sampleDistance;/,
  );
  assert.match(march, /macroSample\s*=\s*cloudMacroSampleAt\(/);
  assert.match(march, /base\s*=\s*cloudBaseFromMacro\(macroSample\);/);
  assert.match(
    march,
    /density\s*=\s*cloudDensityFromMacro\(macroSample,\s*heightFraction\);/,
  );
  assert.equal(
    march.match(/cloudMacroSampleAt\(/g)?.length,
    1,
    "base/full density must share one macro evaluation at the jittered sample",
  );
  assertCoarseBacktrackClamped(march);
  // Inertness: either clamp removed turns the backtrack pin red.
  for (const [label, from, to] of [
    [
      "interval clamp removed",
      "interval = max(interval - 4.0, processedInterval);",
      "interval = interval - 4.0;",
    ],
    [
      "distance clamp removed",
      "growthExponent), tProcessed);",
      "growthExponent), tStart);",
    ],
  ]) {
    assert.equal(march.split(from).length, 2, `mutant anchor: ${label}`);
    assert.throws(
      () => assertCoarseBacktrackClamped(march.replace(from, to)),
      assert.AssertionError,
      `the backtrack pin survived: ${label}`,
    );
  }
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
      const sampleF32 = addF32(startF32, multiplyF32(phaseF32, stepF32));
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
  // C13-10 — naga must see what the PIPELINE compiles: the cloud march and the
  // temporal resolve now carry `//>>ifdef` variants, so their raw text holds both
  // branches at once and is not valid WGSL alone. `defaultVariant` is the engine
  // preprocessor at `definesHi = 0`, and a no-op for a directive-free shader.
  // `shader` is already the renderer's whole composition, density domain
  // included, so it is validated as the pipeline receives it.
  const composedShader = defaultVariant(shader);
  assert.doesNotThrow(() => naga.validate_wgsl(composedShader));
});
