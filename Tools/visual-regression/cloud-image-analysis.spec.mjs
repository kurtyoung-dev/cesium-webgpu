// @purpose node:test guard for lib/cloud-image-analysis.mjs: analyze/compare/periodicity-factorial classification on deterministic synthetic noise images.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeCloudImages,
  classifyCloudPeriodicityFactorial,
  compareCloudImages,
} from "./lib/cloud-image-analysis.mjs";

const WIDTH = 192;
const HEIGHT = 128;

function deterministicNoise(x, y, seed) {
  let value =
    Math.imul(x + seed * 17, 0x45d9f3b) ^ Math.imul(y + seed * 31, 0x119de1f3);
  value ^= value >>> 16;
  value = Math.imul(value, 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function makeImage(signal) {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const value = Math.max(0, Math.min(1, signal(x, y)));
      const byte = Math.round(value * 255);
      const offset = (y * WIDTH + x) * 4;
      data[offset] = byte;
      data[offset + 1] = byte;
      data[offset + 2] = byte;
      data[offset + 3] = 255;
    }
  }
  return { data, width: WIDTH, height: HEIGHT, channels: 4 };
}

const off = makeImage(() => 0);

function irregularBase(x, y, seed = 1) {
  const coarse =
    0.08 * Math.sin(x * 0.047 + y * 0.021) +
    0.06 * Math.cos(x * 0.019 - y * 0.063);
  const noise = (deterministicNoise(x, y, seed) - 0.5) * 0.025;
  return 0.48 + coarse + noise;
}

test("directional autocorrelation separates a lattice from irregular cloud structure", () => {
  const irregular = makeImage((x, y) => irregularBase(x, y));
  const lattice = makeImage(
    (x, y) =>
      irregularBase(x, y) +
      0.18 * Math.sin((2 * Math.PI * x) / 24) +
      0.12 * Math.sin((2 * Math.PI * y) / 16),
  );
  const irregularAnalysis = analyzeCloudImages(irregular, off);
  const latticeAnalysis = analyzeCloudImages(lattice, off);

  assert.ok(irregularAnalysis.morphology.cloudPixels > 10_000);
  assert.ok(latticeAnalysis.morphology.cloudPixels > 10_000);
  assert.ok(
    latticeAnalysis.periodicity.score >
      irregularAnalysis.periodicity.score + 0.08,
    `expected lattice score ${latticeAnalysis.periodicity.score} to exceed irregular ${irregularAnalysis.periodicity.score}`,
  );
  assert.ok(latticeAnalysis.periodicity.peaks.length > 0);
});

test("factorial attribution reports baked-only repeat peaks", () => {
  const liveMidpointImage = makeImage((x, y) => irregularBase(x, y, 2));
  const liveIgnImage = makeImage(
    (x, y) =>
      irregularBase(x, y, 2) + (deterministicNoise(x, y, 8) - 0.5) * 0.015,
  );
  const bakedMidpointImage = makeImage(
    (x, y) => irregularBase(x, y, 2) + 0.2 * Math.sin((2 * Math.PI * x) / 24),
  );
  const bakedIgnImage = makeImage(
    (x, y) =>
      irregularBase(x, y, 2) +
      0.2 * Math.sin((2 * Math.PI * x) / 24 + 0.2) +
      (deterministicNoise(x, y, 8) - 0.5) * 0.015,
  );
  const classification = classifyCloudPeriodicityFactorial({
    bakedMidpoint: analyzeCloudImages(bakedMidpointImage, off),
    bakedIgn: analyzeCloudImages(bakedIgnImage, off),
    liveMidpoint: analyzeCloudImages(liveMidpointImage, off),
    liveIgn: analyzeCloudImages(liveIgnImage, off),
  });

  assert.ok(classification.persistentBakedOnlyPeakCount > 0);
  assert.ok(classification.bakedScoreExcess > 0.05);
  assert.equal(classification.candidateGate.passed, false);
});

test("factorial attribution identifies a common screen-space pattern", () => {
  const withRayPattern = (x, y, seed, phase) =>
    irregularBase(x, y, seed) + 0.16 * Math.sin((2 * Math.PI * y) / 20 + phase);
  const classification = classifyCloudPeriodicityFactorial({
    bakedMidpoint: analyzeCloudImages(
      makeImage((x, y) => withRayPattern(x, y, 3, 0)),
      off,
    ),
    bakedIgn: analyzeCloudImages(
      makeImage((x, y) => withRayPattern(x, y, 3, 0.15)),
      off,
    ),
    liveMidpoint: analyzeCloudImages(
      makeImage((x, y) => withRayPattern(x, y, 5, 0)),
      off,
    ),
    liveIgn: analyzeCloudImages(
      makeImage((x, y) => withRayPattern(x, y, 5, 0.15)),
      off,
    ),
  });

  assert.ok(classification.commonRayOrScreenPeakCount > 0);
});

test("image comparison records branch-changing pixels", () => {
  const left = makeImage((x, y) => irregularBase(x, y, 6));
  const same = makeImage((x, y) => irregularBase(x, y, 6));
  const right = makeImage(
    (x, y) => irregularBase(x, y, 6) + (x > WIDTH / 2 ? 0.05 : 0),
  );
  assert.equal(compareCloudImages(left, same).differentPixels, 0);
  const changed = compareCloudImages(left, right);
  assert.ok(changed.differentPixels > WIDTH * HEIGHT * 0.4);
  assert.ok(changed.meanAbsoluteRgbDelta > 0.01);
});
