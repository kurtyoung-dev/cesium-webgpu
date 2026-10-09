// metrics-c11.spec.mjs — the C11 family's extracted pixel metrics. Pure Node:
// no browser, no GPU, no image on disk.
//
// @purpose Proves lib/metrics/c11-footprint, c11-component-shape, c11-frame-difference and c11-frame-nonvacuity return exactly what the inline harness code they replaced returned (verbatim references over seeded frames), pins each on hand-computed frames, and shows a size mismatch throws by default while the harnesses' opt-in not-comparable record fails the verdict that reads it.
// @status ACTIVE
//
// THREE KINDS OF TEST. Equivalence tests run the pre-harvest body (copied
// verbatim into fixtures/metrics-c11-references.mjs) and the kit function over the
// same seeded frames and compare the JSON text, so a field that changed value
// OR moved position in the receipt fails. Behaviour tests pin each function on
// a frame small enough to count by hand, so the equivalence tests cannot both
// be wrong in the same way. Size-mismatch tests require the default call to
// THROW (no returned value fails every check a caller might write), and feed
// the opt-in `onSizeMismatch: "not-comparable"` record the two harnesses use to
// the harness verdict that consumes it (C11-13 assessCrossBackendEvidence,
// C11-90's strips-versus-fans check) and require a FAIL.

import assert from "node:assert/strict";
import test from "node:test";

import {
  assessCrossBackendEvidence,
  assessPixelEvidence,
  compareBackendCaptures,
} from "./lib/c11-13-voxel-inside-camera-probe.mjs";
import { assessShapeAuthority } from "./lib/c11-90-primitive-restart-probe.mjs";
import {
  referenceAnalyzePng,
  referenceAnalyzeScreenshot,
  referenceCompareBackendCaptures,
  referenceImageDifference,
  referenceImageMetrics,
} from "./fixtures/metrics-c11-references.mjs";
import {
  ACHROMATIC_SUBJECT_DEFAULTS,
  achromaticMask,
  componentShapeStats,
} from "./lib/metrics/c11-component-shape.mjs";
import {
  FOOTPRINT_DEFAULTS,
  compareFootprints,
  nonBlackFootprint,
} from "./lib/metrics/c11-footprint.mjs";
import {
  FRAME_DIFFERENCE_DEFAULTS,
  frameDifference,
} from "./lib/metrics/c11-frame-difference.mjs";
import {
  FRAME_NONVACUITY_DEFAULTS,
  frameNonVacuity,
} from "./lib/metrics/c11-frame-nonvacuity.mjs";

/** Deterministic 32-bit PRNG (mulberry32) so every seeded frame is reproducible. */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A frame in sharp's raw shape: `{ data, info }` with `channels` 3 or 4. */
function rawFrame(width, height, channels, paint) {
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = paint(x, y);
      const o = (y * width + x) * channels;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      if (channels === 4) data[o + 3] = a;
    }
  }
  return { data, info: { width, height, channels } };
}

const kitFrame = ({ data, info }) => ({
  width: info.width,
  height: info.height,
  channels: info.channels,
  data,
});

/** A voxel-like subject: a green blob of random extent on black with noise. */
function voxelScene(seed, width = 96, height = 72, channels = 3) {
  const rand = prng(seed);
  const cx = width * (0.3 + 0.4 * rand());
  const cy = height * (0.3 + 0.4 * rand());
  const rx = width * (0.1 + 0.3 * rand());
  const ry = height * (0.1 + 0.3 * rand());
  return rawFrame(width, height, channels, (x, y) => {
    const inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    const noise = Math.floor(rand() * 24);
    return inside
      ? [40 + noise, 150 + Math.floor(rand() * 90), 60 + noise]
      : [noise, noise, Math.floor(rand() * 20)];
  });
}

/** A restart-like subject: grey shapes (bars or discs) on a coloured backdrop. */
function restartScene(
  seed,
  kind,
  width = 160,
  height = 90,
  channels = 3,
  speckle = 0.01,
) {
  const rand = prng(seed);
  const shapes = Array.from({ length: 9 }, (_, i) => ({
    cx: 10 + i * 17 + Math.floor(rand() * 3),
    cy: 45 + Math.floor(rand() * 5) - 2,
  }));
  return rawFrame(width, height, channels, (x, y) => {
    const grey = shapes.some(({ cx, cy }) =>
      kind === "bars"
        ? Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 20
        : (x - cx) ** 2 + (y - cy) ** 2 <= 36,
    );
    if (grey) {
      const v = 120 + Math.floor(rand() * 40);
      return [v, v + Math.floor(rand() * 10), v];
    }
    // A speckle of isolated grey pixels and small grey clusters exercises the
    // significance floor and the diagonal (8-connected) joins.
    if (rand() < speckle) return [90, 92, 88];
    return [20 + Math.floor(rand() * 30), 60, 160 + Math.floor(rand() * 60)];
  });
}

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

function withoutHashes(metrics) {
  const { rawBytes, rawSha256, pngBytes, pngSha256, ...rest } = metrics;
  void rawBytes;
  void rawSha256;
  void pngBytes;
  void pngSha256;
  return rest;
}

test("nonBlackFootprint equals the C11-13 analyzePng body over ten seeded scenes", () => {
  let nonVacuous = 0;
  for (const seed of SEEDS) {
    const raw = voxelScene(seed);
    const reference = referenceAnalyzePng(Buffer.from("png"), raw);
    const kit = nonBlackFootprint(kitFrame(raw), {
      nonBlackThreshold: 18,
      interiorFraction: 0.2,
      centerPatchRadius: 4,
    });
    assert.equal(
      JSON.stringify(kit.metrics),
      JSON.stringify(withoutHashes(reference.metrics)),
      `seed ${seed}`,
    );
    assert.deepEqual(Buffer.from(kit.mask), Buffer.from(reference.mask));
    if (kit.metrics.nonBlackPixels > 0 && kit.metrics.boundingBox) nonVacuous++;
  }
  assert.equal(nonVacuous, SEEDS.length, "every seeded scene has a footprint");
});

test("nonBlackFootprint counts a hand-built frame and reads RGBA like RGB", () => {
  // 10x10 black frame, a 4x4 square (x 3..6, y 3..6) of (10, 200, 40), and one
  // dim pixel (17, 17, 17) at (0, 0) that sits just under the bar of 18.
  const paint = (x, y) => {
    if (x === 0 && y === 0) return [17, 17, 17];
    if (x >= 3 && x <= 6 && y >= 3 && y <= 6) return [10, 200, 40];
    return [0, 0, 0];
  };
  const rgb = kitFrame(rawFrame(10, 10, 3, paint));
  const rgba = kitFrame(rawFrame(10, 10, 4, paint));
  const { metrics, mask } = nonBlackFootprint(rgb);
  assert.equal(FOOTPRINT_DEFAULTS.nonBlackThreshold, 18);
  assert.equal(metrics.nonBlackPixels, 16);
  assert.equal(metrics.nonBlackFraction, 0.16);
  // Interior window is x,y in [2, 8): the whole square.
  assert.equal(metrics.interiorNonBlackPixels, 16);
  // Centre (5,5), radius 4: the whole square.
  assert.equal(metrics.centerPatchNonBlackPixels, 16);
  assert.deepEqual(metrics.centerPixelRgb, [10, 200, 40]);
  assert.equal(metrics.centerPixelMaximum, 200);
  assert.deepEqual(metrics.meanRgb, [10, 200, 40]);
  assert.equal(metrics.greenDominance, 160);
  assert.deepEqual(metrics.boundingBox, {
    minX: 3,
    minY: 3,
    maxX: 6,
    maxY: 6,
    width: 4,
    height: 4,
  });
  assert.equal(mask[0], 0);
  assert.equal(mask[3 * 10 + 3], 1);
  const fromRgba = nonBlackFootprint(rgba);
  assert.equal(fromRgba.metrics.channels, 4);
  assert.deepEqual(
    { ...fromRgba.metrics, channels: 3 },
    { ...metrics, channels: 3 },
  );
  assert.throws(
    () => nonBlackFootprint({ width: 10, height: 10, data: new Uint8Array(3) }),
    /needs 400 bytes/,
  );
  // An empty frame has no box and fails the harness's pixel-evidence verdict.
  const black = nonBlackFootprint(kitFrame(rawFrame(8, 8, 3, () => [0, 0, 0])));
  assert.equal(black.metrics.boundingBox, null);
  assert.deepEqual(black.metrics.meanRgb, [0, 0, 0]);
  assert.equal(
    assessPixelEvidence({ ...black.metrics, rawSha256: "A".repeat(64) }).pass,
    false,
  );
});

test("compareFootprints equals the C11-13 compareBackendCaptures body over seeded pairs", () => {
  for (const seed of SEEDS) {
    const a = voxelScene(seed);
    const b = voxelScene(seed + 1000);
    const legA = nonBlackFootprint(kitFrame(a));
    const legB = nonBlackFootprint(kitFrame(b));
    const reference = referenceCompareBackendCaptures(
      referenceAnalyzePng(Buffer.from("a"), a),
      referenceAnalyzePng(Buffer.from("b"), b),
    );
    const kit = compareFootprints(legA, legB, { minimumNonBlackPixels: 512 });
    assert.equal(
      JSON.stringify(kit),
      JSON.stringify(reference),
      `seed ${seed}`,
    );
    const self = compareFootprints(legA, legA, { minimumNonBlackPixels: 512 });
    assert.equal(self.footprintIou, 1);
    assert.equal(self.meanColorL1, 0);
  }
});

test("compareFootprints: a size mismatch throws by default, and the C11-13 opt-in record fails its verdict", () => {
  const small = nonBlackFootprint(kitFrame(voxelScene(7, 96, 72)));
  const large = nonBlackFootprint(kitFrame(voxelScene(7, 96, 73)));
  // Default: no answer, so no check a caller writes can pass on it.
  assert.throws(
    () => compareFootprints(small, large, { minimumNonBlackPixels: 512 }),
    (error) =>
      error instanceof RangeError &&
      /not the same size/.test(error.message) &&
      /96x72/.test(error.message) &&
      /96x73/.test(error.message),
  );
  // A width-only mismatch throws the same RangeError and its opt-in record
  // fails the verdict too (review N1).
  const wide = nonBlackFootprint(kitFrame(voxelScene(7, 97, 72)));
  assert.throws(
    () => compareFootprints(small, wide, { minimumNonBlackPixels: 512 }),
    (error) =>
      error instanceof RangeError &&
      /96x72/.test(error.message) &&
      /97x72/.test(error.message),
  );
  const wideRecord = compareFootprints(small, wide, {
    minimumNonBlackPixels: 512,
    onSizeMismatch: "not-comparable",
  });
  assert.equal(wideRecord.comparable, false);
  assert.equal(
    JSON.stringify(wideRecord),
    JSON.stringify(
      referenceCompareBackendCaptures(
        referenceAnalyzePng(Buffer.from("a"), voxelScene(7, 96, 72)),
        referenceAnalyzePng(Buffer.from("b"), voxelScene(7, 97, 72)),
      ),
    ),
  );
  assert.equal(assessCrossBackendEvidence(wideRecord).pass, false);
  // A real frame pair that differs in width or height also differs in mask
  // length, so each of the three size clauses is tested alone on a hand-built
  // footprint: a declared width, a declared height, and a mask of the wrong
  // length (the bad-length case). Each throws by default.
  const sizeClauses = [
    { ...small, metrics: { ...small.metrics, width: 97 } },
    { ...small, metrics: { ...small.metrics, height: 73 } },
    { ...small, mask: small.mask.subarray(0, small.mask.length - 1) },
  ];
  for (const odd of sizeClauses) {
    assert.throws(
      () => compareFootprints(small, odd, { minimumNonBlackPixels: 512 }),
      (error) =>
        error instanceof RangeError && /not the same size/.test(error.message),
    );
  }
  assert.throws(
    () =>
      compareFootprints(small, sizeClauses[2], { minimumNonBlackPixels: 512 }),
    /\(mask 6912\), candidate 96x72 \(mask 6911\)/,
  );
  assert.throws(
    () =>
      compareFootprints(small, small, {
        minimumNonBlackPixels: 512,
        onSizeMismatch: "ignore",
      }),
    /onSizeMismatch must be/,
  );
  // Opt-in: the record C11-13 has always written, equal to the pre-harvest body.
  const mismatch = compareFootprints(small, large, {
    minimumNonBlackPixels: 512,
    onSizeMismatch: "not-comparable",
  });
  assert.equal(mismatch.comparable, false);
  assert.equal(mismatch.footprintIou, 0);
  assert.equal(mismatch.footprintRatio, null);
  assert.equal(mismatch.meanColorL1, Number.POSITIVE_INFINITY);
  assert.equal(
    JSON.stringify(mismatch),
    JSON.stringify(
      referenceCompareBackendCaptures(
        referenceAnalyzePng(Buffer.from("a"), voxelScene(7, 96, 72)),
        referenceAnalyzePng(Buffer.from("b"), voxelScene(7, 96, 73)),
      ),
    ),
  );
  assert.equal(assessCrossBackendEvidence(mismatch).pass, false);
  // The harness's own entry point opts in, so its receipt keeps that record.
  const harness = compareBackendCaptures(small, large);
  assert.equal(JSON.stringify(harness), JSON.stringify(mismatch));
  assert.equal(assessCrossBackendEvidence(harness).pass, false);
  // A black/black pair is comparable but vacuous, and also fails.
  const black = nonBlackFootprint(kitFrame(rawFrame(8, 8, 3, () => [0, 0, 0])));
  const vacuous = compareFootprints(black, black, {
    minimumNonBlackPixels: 512,
  });
  assert.equal(vacuous.comparable, true);
  assert.equal(vacuous.bothNonVacuous, false);
  assert.equal(assessCrossBackendEvidence(vacuous).pass, false);
  // The size floor is required: no silent default for a non-vacuity bar.
  assert.throws(() => compareFootprints(small, small), /minimumNonBlackPixels/);
});

test("achromaticMask + componentShapeStats equal the C11-90 imageMetrics body over seeded scenes", () => {
  let nineFound = 0;
  for (const seed of SEEDS) {
    for (const kind of ["bars", "discs"]) {
      const raw = restartScene(seed, kind);
      const fileFacts = { bytes: 4136, sha256: "F".repeat(64) };
      const reference = referenceImageMetrics(raw, fileFacts);
      const kit = {
        width: raw.info.width,
        height: raw.info.height,
        bytes: fileFacts.bytes,
        sha256: fileFacts.sha256,
        ...componentShapeStats(
          achromaticMask(kitFrame(raw), {
            minimumMaximum: 32,
            maximumSpread: 42,
          }),
          {
            minimumComponentPixels: 64,
            componentFraction: 0.00005,
            listLimit: 16,
          },
        ),
      };
      assert.equal(
        JSON.stringify(kit),
        JSON.stringify(reference),
        `seed ${seed} ${kind}`,
      );
      if (kit.significantComponentCount === 9) nineFound++;
    }
  }
  assert.ok(
    nineFound >= SEEDS.length,
    "the seeded scenes reach nine components",
  );
});

test("componentShapeStats on hand-built shapes: 8-connectivity, the floor, and C11-90's aspect law", () => {
  assert.deepEqual(
    {
      minimumMaximum: ACHROMATIC_SUBJECT_DEFAULTS.minimumMaximum,
      maximumSpread: ACHROMATIC_SUBJECT_DEFAULTS.maximumSpread,
    },
    { minimumMaximum: 32, maximumSpread: 42 },
  );
  // Two 3x3 grey squares touching only at a corner are ONE 8-connected
  // component of 18 pixels; a coloured pixel is not in the mask.
  const raw = rawFrame(12, 12, 3, (x, y) => {
    if ((x <= 2 && y <= 2) || (x >= 3 && x <= 5 && y >= 3 && y <= 5)) {
      return [100, 100, 100];
    }
    if (x === 10 && y === 10) return [200, 20, 20];
    return [0, 0, 0];
  });
  const masked = achromaticMask(kitFrame(raw));
  assert.equal(masked.maskPixels, 18);
  const stats = componentShapeStats(masked, { minimumComponentPixels: 1 });
  assert.equal(stats.significantComponentCount, 1);
  assert.equal(stats.significantComponents[0].pixels, 18);
  assert.deepEqual(stats.significantComponents[0].bounds, {
    minimumX: 0,
    maximumX: 5,
    minimumY: 0,
    maximumY: 5,
  });
  // The default floor (64 px) drops it; coverage and balance then read 0.
  const floored = componentShapeStats(masked);
  assert.equal(floored.significantComponentThreshold, 64);
  assert.equal(floored.significantComponentCount, 0);
  assert.equal(floored.componentBalance, 0);
  assert.equal(floored.significantComponentCoverage, 0);
  // Nine tall bars satisfy the strip law; nine discs satisfy the fan law
  // (a light speckle, so the significant components cover >= 0.9 of the mask).
  const bars = componentShapeStats(
    achromaticMask(kitFrame(restartScene(3, "bars", 160, 90, 3, 0.002))),
  );
  const discs = componentShapeStats(
    achromaticMask(kitFrame(restartScene(3, "discs", 160, 90, 3, 0.002))),
  );
  assert.equal(assessShapeAuthority("triangle-strips", bars).pass, true);
  assert.equal(assessShapeAuthority("triangle-fans", discs).pass, true);
  assert.equal(assessShapeAuthority("triangle-strips", discs).pass, false);
  assert.equal(assessShapeAuthority("triangle-fans", bars).pass, false);
  // A frame or mask whose length does not match its declared shape is refused
  // (review N1, the bad-length case).
  assert.throws(
    () =>
      achromaticMask({
        width: 10,
        height: 10,
        channels: 3,
        data: new Uint8Array(299),
      }),
    /achromaticMask: 10x10x3 needs 300 bytes, got 299/,
  );
  assert.throws(
    () =>
      componentShapeStats({
        width: 10,
        height: 10,
        mask: new Uint8Array(99),
        maskPixels: 0,
      }),
    /componentShapeStats: mask must hold 100 entries, got 99/,
  );
});

test("componentShapeStats lists at most listLimit components but counts them all, as C11-90 did", () => {
  // Twenty 9x9 grey squares (81 px each, above the 64 px floor), one column
  // apart so no two touch: more than the 16 the receipt lists (review N1).
  const raw = rawFrame(200, 10, 3, (x, y) =>
    x % 10 !== 9 && y < 9 ? [100, 100, 100] : [0, 0, 0],
  );
  const fileFacts = { bytes: 1, sha256: "E".repeat(64) };
  const kit = {
    width: 200,
    height: 10,
    bytes: fileFacts.bytes,
    sha256: fileFacts.sha256,
    ...componentShapeStats(achromaticMask(kitFrame(raw))),
  };
  assert.equal(kit.significantComponentCount, 20);
  assert.equal(kit.significantComponentPixels, 20 * 81);
  assert.equal(kit.significantComponentSizes.length, 16);
  assert.equal(kit.significantComponents.length, 16);
  assert.equal(
    JSON.stringify(kit),
    JSON.stringify(referenceImageMetrics(raw, fileFacts)),
  );
  const four = componentShapeStats(achromaticMask(kitFrame(raw)), {
    listLimit: 4,
  });
  assert.equal(four.significantComponentCount, 20);
  assert.equal(four.significantComponentSizes.length, 4);
  assert.equal(four.significantComponents.length, 4);
});

test("frameDifference equals the C11-90 imageDifference body over seeded pairs", () => {
  for (const seed of SEEDS) {
    for (const channels of [3, 4]) {
      const a = restartScene(seed, "bars", 160, 90, channels);
      const b = restartScene(seed, "discs", 160, 90, channels);
      const reference = referenceImageDifference(a, b);
      const kit = frameDifference(kitFrame(a), kitFrame(b), {
        changedChannelDelta: 12,
      });
      assert.equal(
        JSON.stringify(kit),
        JSON.stringify(reference),
        `seed ${seed}`,
      );
      assert.ok(kit.changedPixels > 0);
    }
  }
});

test("frameDifference: the bar, identical frames, a size mismatch that throws, and the C11-90 opt-in record that fails its check", () => {
  assert.equal(FRAME_DIFFERENCE_DEFAULTS.changedChannelDelta, 12);
  // One pixel moved by exactly 12 on green counts; one moved by 11 does not.
  const base = rawFrame(4, 1, 3, () => [50, 50, 50]);
  const moved = rawFrame(4, 1, 3, (x) =>
    x === 0 ? [50, 62, 50] : x === 1 ? [50, 61, 50] : [50, 50, 50],
  );
  const d = frameDifference(kitFrame(base), kitFrame(moved));
  assert.equal(d.comparable, true);
  assert.equal(d.changedPixels, 1);
  assert.equal(d.meanAbsoluteDelta, 23 / 12);
  const same = frameDifference(kitFrame(base), kitFrame(base));
  assert.deepEqual(same, {
    comparable: true,
    changedPixels: 0,
    meanAbsoluteDelta: 0,
  });
  // C11-90's check: `difference.comparable && difference.changedPixels >= 1_000`.
  const distinguishes = (difference) =>
    difference.comparable && difference.changedPixels >= 1_000;
  const strips = kitFrame(restartScene(4, "bars"));
  const fans = kitFrame(restartScene(4, "discs"));
  assert.equal(distinguishes(frameDifference(strips, fans)), true);
  const cropped = kitFrame(restartScene(4, "discs", 160, 89));
  const rgba = kitFrame(restartScene(4, "discs", 160, 90, 4));
  // Default: a height or channel-count mismatch throws, naming both shapes.
  assert.throws(
    () => frameDifference(strips, cropped),
    (error) =>
      error instanceof RangeError &&
      /not the same shape/.test(error.message) &&
      /160x90x3 vs 160x89x3/.test(error.message),
  );
  assert.throws(() => frameDifference(strips, rgba), /160x90x3 vs 160x90x4/);
  // A width-only mismatch is the same RangeError (review N1), not the plain
  // Error diffImages would throw if the width clause were missing, and the
  // opt-in record still fails the check.
  const widened = kitFrame(restartScene(4, "discs", 161, 90));
  assert.throws(
    () => frameDifference(strips, widened),
    (error) =>
      error instanceof RangeError &&
      /not the same shape/.test(error.message) &&
      /160x90x3 vs 161x90x3/.test(error.message),
  );
  const widenedRecord = frameDifference(strips, widened, {
    onSizeMismatch: "not-comparable",
  });
  assert.deepEqual(widenedRecord, {
    comparable: false,
    changedPixels: 0,
    meanAbsoluteDelta: 0,
  });
  assert.equal(distinguishes(widenedRecord), false);
  // A frame whose bytes do not match its declared shape is refused before any
  // comparison (the bad-length case).
  assert.throws(
    () =>
      frameDifference(strips, {
        ...strips,
        data: strips.data.subarray(0, strips.data.length - 1),
      }),
    (error) =>
      error instanceof TypeError &&
      /frameDifference\(second\): 160x90x3 needs 43200 bytes, got 43199/.test(
        error.message,
      ),
  );
  assert.throws(
    () => frameDifference(strips, strips, { onSizeMismatch: "ignore" }),
    /onSizeMismatch must be/,
  );
  // Opt-in (the C11-90 harness): the pre-harvest record, which the check fails.
  const notComparable = { onSizeMismatch: "not-comparable" };
  const mismatch = frameDifference(strips, cropped, notComparable);
  assert.deepEqual(mismatch, {
    comparable: false,
    changedPixels: 0,
    meanAbsoluteDelta: 0,
  });
  assert.equal(
    JSON.stringify(mismatch),
    JSON.stringify(
      referenceImageDifference(
        restartScene(4, "bars"),
        restartScene(4, "discs", 160, 89),
      ),
    ),
  );
  assert.equal(distinguishes(mismatch), false);
  assert.equal(frameDifference(strips, rgba, notComparable).comparable, false);
});

test("frameNonVacuity equals the C11-209 analyzeScreenshot body over seeded frames", () => {
  for (const seed of SEEDS) {
    for (const raw of [
      voxelScene(seed, 64, 48, 3),
      restartScene(seed, "bars", 160, 90, 4),
    ]) {
      const reference = referenceAnalyzeScreenshot(raw);
      const kit = frameNonVacuity(kitFrame(raw), {
        nonBlackChannelSum: 24,
        quantizeShift: 4,
      });
      assert.equal(
        JSON.stringify(kit),
        JSON.stringify(reference),
        `seed ${seed}`,
      );
    }
  }
});

test("frameNonVacuity on hand-built frames, and C11-209's visibility bar", () => {
  assert.deepEqual(FRAME_NONVACUITY_DEFAULTS, {
    nonBlackChannelSum: 24,
    quantizeShift: 4,
  });
  // C11-209's bar: nonBlackFraction > 0.05, >= 8 colours, luma stddev > 1.
  const visible = (s) =>
    s.nonBlackFraction > 0.05 &&
    s.distinctQuantizedColors >= 8 &&
    s.lumaStddev > 1;
  const black = frameNonVacuity(kitFrame(rawFrame(16, 16, 4, () => [0, 0, 0])));
  assert.equal(black.nonBlackPixels, 0);
  assert.equal(black.distinctQuantizedColors, 1);
  assert.equal(black.lumaStddev, 0);
  assert.equal(visible(black), false);
  // A pixel at R+G+B = 24 is black; 25 is not.
  const edge = frameNonVacuity(
    kitFrame(rawFrame(2, 1, 3, (x) => (x === 0 ? [8, 8, 8] : [9, 8, 8]))),
  );
  assert.equal(edge.nonBlackPixels, 1);
  assert.equal(edge.nonBlackFraction, 0.5);
  // Two flat halves: two colours, luma spread = half the luma difference.
  const halves = frameNonVacuity(
    kitFrame(rawFrame(2, 1, 3, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]))),
  );
  assert.equal(halves.distinctQuantizedColors, 2);
  assert.ok(Math.abs(halves.lumaStddev - 127.5) < 1e-9);
  assert.equal(visible(frameNonVacuity(kitFrame(voxelScene(2, 64, 48)))), true);
  assert.throws(
    () => frameNonVacuity({ width: 2, height: 2, channels: 5, data: [] }),
    /channels must be 3 or 4/,
  );
  // Bytes that do not match the declared shape are refused (review N1).
  assert.throws(
    () =>
      frameNonVacuity({
        width: 2,
        height: 2,
        channels: 3,
        data: new Uint8Array(11),
      }),
    /frameNonVacuity: 2x2x3 needs 12 bytes, got 11/,
  );
});
