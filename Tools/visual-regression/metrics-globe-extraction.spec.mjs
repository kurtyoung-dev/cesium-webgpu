// @purpose Pins that moving the globe probes' in-page pixel arithmetic into lib/metrics changed no number: each new metric, run over the synthetic frames of fixtures/globe-metrics-inputs.mjs, must reproduce exactly what the ORIGINAL in-page source returned over the same frames (fixtures/globe-metrics.golden.json), plus the edges each metric refuses.
// @status ACTIVE
//
// WHY A GOLDEN FROM THE ORIGINAL SOURCE. The arithmetic these metrics carry
// used to run inside `page.evaluate`, so there was no Node module to diff
// against. The golden was produced by slicing each probe's own in-page source
// VERBATIM out of the probes as committed at 7e12d8f1d0 (through `git show`,
// never the working tree), running it in Node with stubs only for the browser
// decode (Image, a 2D canvas, ImageData) over the frames the fixture module
// generates, and banking what it returned. The capture script is lane evidence
// (`_lane-out/golden-capture/capture-globe-metrics-golden.mjs` in the Erebor
// harvest lane); the golden records the base commit it read.
//
// **Regenerate the golden only when a banked number is deliberately changed.**
// A regeneration that accompanies a refactor is the spec being edited to agree
// with the code it exists to check.
//
// EXACTNESS. The comparisons are `deepStrictEqual` over the values the probes
// banked, in the form they banked them (a number, or the `toFixed` string they
// printed), so a reordered accumulation that moves a bit fails here.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as inputs from "./fixtures/globe-metrics-inputs.mjs";
import { diffImages } from "./lib/image-diff.mjs";
import { channelExcessShift } from "./lib/metrics/channel-excess-shift.mjs";
import { colourDiversity } from "./lib/metrics/colour-diversity.mjs";
import {
  bestProfileShift,
  consensusDisc,
  discCentreRadius,
  latitudeProfile,
} from "./lib/metrics/globe-disc.mjs";
import {
  MISMATCH_BUCKETS,
  bucketCentroids,
  mismatchBuckets,
  openMask,
  summariseBuckets,
} from "./lib/metrics/mismatch-buckets.mjs";
import {
  centredSquare,
  rgbMeanInRoi,
  rgbSumBelowFraction,
  rgbSumDiff,
} from "./lib/metrics/rgb-sum.mjs";
import { classifyDecode } from "./lib/metrics/srgb-decode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(
    path.join(HERE, "fixtures", "globe-metrics.golden.json"),
    "utf8",
  ),
);
/** The crop `probe-globe-polar-stretch` and `probe-globe-farzoom` measured in. */
const POLAR_CROP = Object.freeze({ x0: 250, x1: 1010, y0: 45, y1: 640 });

function goldenCase(key) {
  const entry = GOLDEN.cases[key];
  assert.ok(entry, `golden case ${key} is missing`);
  return entry;
}

const sha256 = (bytes) =>
  createHash("sha256").update(Buffer.from(bytes.buffer)).digest("hex");

test("the golden records the base it was captured from and every case", () => {
  assert.equal(GOLDEN.schema, "globe-metrics-golden/1");
  assert.equal(GOLDEN.base, "7e12d8f1d0");
  assert.deepEqual(Object.keys(GOLDEN.cases).sort(), [
    "probe-globe-bindgroup-cache.mjs#phaseC",
    "probe-globe-clippoly-geodetic.mjs#analyze",
    "probe-globe-default-limits.mjs#analyze",
    "probe-globe-default-limits.mjs#phaseDiff",
    "probe-globe-effects-handle-toggle.mjs#diff",
    "probe-globe-farzoom.mjs#analyze",
    "probe-globe-farzoom.mjs#selfDiff",
    "probe-globe-hdr-gamma.mjs#regionAndDecode",
    "probe-globe-polar-stretch.mjs#analyze",
    "probe-globe-translucency.mjs#diffPngs",
    "probe-globe-underground.mjs#diffPngs",
  ]);
});

for (const file of [
  "probe-globe-translucency.mjs",
  "probe-globe-underground.mjs",
]) {
  test(`rgbSumDiff reproduces ${file}'s diffPngs exactly`, () => {
    const { first, second } = inputs.spreadDiffPair();
    const m = rgbSumDiff(first, second);
    assert.deepStrictEqual(
      {
        totalPx: m.countedPx,
        mismatchPx: m.mismatchPx,
        mismatchPct: m.mismatchPct,
        meanDelta: m.meanAbsSum.toFixed(2),
        meanSignedDR: m.meanSigned.r.toFixed(2),
        meanSignedDG: m.meanSigned.g.toFixed(2),
        meanSignedDB: m.meanSigned.b.toFixed(2),
      },
      goldenCase(`${file}#diffPngs`).output,
    );
  });
}

test("rgbSumDiff and rgbSumBelowFraction reproduce probe-globe-clippoly-geodetic's analyze", () => {
  const { holed, solid } = inputs.clippedHoleFrames();
  const centre = (img) =>
    centredSquare(Math.floor(img.width / 2), Math.floor(img.height / 2), 60);
  assert.deepStrictEqual(
    {
      mismatchPct: rgbSumDiff(holed, solid).mismatchPct.toFixed(2),
      holeFracA: rgbSumBelowFraction(holed, centre(holed)).fraction.toFixed(3),
      holeFracB: rgbSumBelowFraction(solid, centre(solid)).fraction.toFixed(3),
    },
    goldenCase("probe-globe-clippoly-geodetic.mjs#analyze").output,
  );
});

function polarAnalysis(first, second) {
  const diff = rgbSumDiff(first, second, {
    roi: POLAR_CROP,
    returnMask: true,
  });
  const disc = consensusDisc(first, second, POLAR_CROP);
  const pa = latitudeProfile(first, disc);
  const pb = latitudeProfile(second, disc);
  const buckets = mismatchBuckets(first, second, {
    crop: POLAR_CROP,
    mask: diff.mask,
    disc: discCentreRadius(disc),
  });
  return { diff, pa, pb, shift: bestProfileShift(pa, pb), buckets };
}

test("the globe-disc and mismatch-bucket metrics reproduce probe-globe-polar-stretch's analyze, mask included", () => {
  const { first, second } = inputs.globeDiscPair();
  const { diff, pa, pb, shift, buckets } = polarAnalysis(first, second);
  const golden = goldenCase("probe-globe-polar-stretch.mjs#analyze");
  assert.deepStrictEqual(
    {
      mismatchPct: +diff.mismatchPct.toFixed(3),
      discRadius: +pa.r.toFixed(1),
      icePxA: pa.icePx,
      icePxB: pb.icePx,
      iceCentroidYA:
        pa.iceCentroidY === null ? null : +pa.iceCentroidY.toFixed(1),
      iceCentroidYB:
        pb.iceCentroidY === null ? null : +pb.iceCentroidY.toFixed(1),
      bestShift_discUnits: +shift.shift.toFixed(3),
      buckets: summariseBuckets(buckets, {
        cropPx: diff.countedPx,
        mismatchPx: diff.mismatchPx,
      }),
      seamBluePx: buckets.seamFingerprintPx,
    },
    golden.output,
  );
  assert.deepStrictEqual([sha256(buckets.maskRgba)], golden.maskSha256);
  // Non-vacuity: the fixture reaches every bucket and the seam fingerprint.
  for (const k of MISMATCH_BUCKETS) {
    assert.ok(buckets.counts[k] > 0, `fixture leaves bucket ${k} empty`);
  }
  assert.ok(
    buckets.seamFingerprintPx > 0,
    "fixture never trips the seam fingerprint",
  );
});

test("the same metrics reproduce the retired probe-globe-farzoom's analyze and selfDiff", () => {
  const { first, second } = inputs.globeDiscPair();
  const { diff, buckets } = polarAnalysis(first, second);
  const centroid = bucketCentroids(buckets).interiorBlobGpuBrighter;
  // farzoom painted seam-fingerprint pixels cyan where polar-stretch paints
  // them blue, so its mask is not compared; its counts, deltas and centroid are.
  assert.deepStrictEqual(
    {
      mismatchPct: +diff.mismatchPct.toFixed(3),
      mismatchPx: diff.mismatchPx,
      buckets: summariseBuckets(buckets, {
        cropPx: diff.countedPx,
        mismatchPx: diff.mismatchPx,
      }),
      gpuBlobCentroid: centroid
        ? { x: +centroid.x.toFixed(0), y: +centroid.y.toFixed(0) }
        : null,
    },
    goldenCase("probe-globe-farzoom.mjs#analyze").output,
  );
  // selfDiff(on, off) read "on minus off"; rgbSumDiff reads second minus first.
  const drape = rgbSumDiff(first, second, { threshold: 12, roi: POLAR_CROP });
  assert.deepStrictEqual(
    {
      changedPct: +drape.mismatchPct.toFixed(2),
      meanLumDelta_onMinusOff: drape.mismatchPx
        ? +drape.meanMismatchLuma.toFixed(1)
        : 0,
    },
    goldenCase("probe-globe-farzoom.mjs#selfDiff").output,
  );
});

for (const key of [
  "probe-globe-bindgroup-cache.mjs#phaseC",
  "probe-globe-default-limits.mjs#analyze",
]) {
  test(`colourDiversity reproduces ${key}`, () => {
    const { imagery, flat } = inputs.imageryAndFlatFrames();
    const read = (img) => {
      const m = colourDiversity(img);
      return { nonBlackPct: m.nonBlackFraction, colorBuckets: m.colourBuckets };
    };
    assert.deepStrictEqual(
      { imagery: read(imagery), flat: read(flat) },
      goldenCase(key).output,
    );
  });
}

test("channelExcessShift plus diffImages at tolerance 24 reproduce probe-globe-default-limits' phase diff", () => {
  const { before, after } = inputs.greenWashPair();
  const shift = channelExcessShift(before, after);
  const changed = diffImages(before, after, { tolerance: 24 }).changedPx;
  const golden = goldenCase("probe-globe-default-limits.mjs#phaseDiff").output;
  assert.deepStrictEqual(
    {
      changedPct: changed / (before.width * before.height),
      greenShift: shift.shift,
      greenN: shift.litPx,
    },
    golden,
  );
  assert.ok(golden.changedPct > 0, "fixture never crosses tolerance 24");
});

test("diffImages at tolerance 12 reproduces probe-globe-effects-handle-toggle's diff (no new metric needed)", () => {
  const t = inputs.toggleFrames();
  const count = (a, b) => diffImages(a, b, { tolerance: 12 }).changedPx;
  assert.deepStrictEqual(
    {
      onVsBaseline: count(t.on, t.baseline),
      offVsBaseline: count(t.off, t.baseline),
      restoreVsOn: count(t.restore, t.on),
      totalPx: t.baseline.width * t.baseline.height,
    },
    goldenCase("probe-globe-effects-handle-toggle.mjs#diff").output,
  );
});

test("rgbMeanInRoi and classifyDecode reproduce probe-globe-hdr-gamma's region means and decode clauses", () => {
  const { sdr, hdr } = inputs.twoToneGrayFrames();
  const means = (img) => ({
    left: rgbMeanInRoi(
      img,
      centredSquare(Math.round(img.width * 0.18), img.height >> 1, 40),
    ),
    right: rgbMeanInRoi(
      img,
      centredSquare(Math.round(img.width * 0.82), img.height >> 1, 40),
    ),
  });
  const judge = (s, h) => {
    const c = classifyDecode({ sdrMean: s, treatedMean: h });
    return {
      expected: c.expectedSingle,
      single: c.single,
      notMissing: c.notMissing,
      doubled: c.doubleWouldBe,
      notDouble: c.notDouble,
      ok: c.ok,
    };
  };
  const s = means(sdr);
  const h = means(hdr);
  const golden = goldenCase("probe-globe-hdr-gamma.mjs#regionAndDecode").output;
  assert.deepStrictEqual(
    {
      sdr: s,
      hdr: h,
      left: judge(s.left, h.left),
      right: judge(s.right, h.right),
      missingCase: judge(s.left, s.left),
      doubleCase: judge(s.left, 255 * Math.pow(s.left / 255, 4.84)),
    },
    golden,
  );
  // The three outcomes the probe separates are all reached by the fixture.
  assert.equal(golden.left.ok, true);
  assert.equal(golden.missingCase.notMissing, false);
  assert.equal(golden.doubleCase.notDouble, false);
});

test("the summed-channel rule is not diffImages' largest-channel rule, which is why it is its own metric", () => {
  // Three deltas of 12 sum to 36: over 30 for the sum rule, under every
  // largest-channel tolerance the probes used (12 is not > 12).
  const a = {
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([100, 100, 100, 255]),
  };
  const b = {
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([112, 112, 112, 255]),
  };
  assert.equal(rgbSumDiff(a, b).mismatchPx, 1);
  assert.equal(diffImages(a, b, { tolerance: 12 }).changedPx, 0);
});

test("the metrics refuse what the originals silently mis-read", () => {
  const small = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  const other = { width: 3, height: 2, data: new Uint8ClampedArray(24) };
  assert.throws(() => rgbSumDiff(small, other), RangeError);
  // Every two-frame metric refuses frames of different sizes, as rgbSumDiff
  // does, instead of pairing pixels that are not the same pixel.
  const box = { x0: 0, y0: 0, x1: 2, y1: 2 };
  assert.throws(() => channelExcessShift(small, other), RangeError);
  assert.throws(() => consensusDisc(small, other, box), RangeError);
  assert.throws(
    () =>
      mismatchBuckets(small, other, {
        crop: box,
        mask: new Uint8Array(4),
        disc: { cx: 1, cy: 1, radius: 1 },
      }),
    RangeError,
  );
  assert.throws(
    () => rgbSumBelowFraction(small, { x0: 0, y0: 0, x1: 3, y1: 2 }),
    RangeError,
  );
  assert.throws(
    () => rgbMeanInRoi(small, { x0: 1, y0: 1, x1: 1, y1: 2 }),
    RangeError,
  );
  assert.throws(
    () => channelExcessShift(small, small, { channel: "alpha" }),
    RangeError,
  );
  assert.deepStrictEqual(channelExcessShift(small, small), {
    shift: 0,
    litPx: 0,
  });
});

test("openMask removes a one-pixel line and keeps a 3x3 block", () => {
  const w = 8;
  const h = 8;
  const mask = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) mask[1 * w + x] = 1; // a thin line on row 1
  for (let y = 4; y < 7; y++) for (let x = 3; x < 6; x++) mask[y * w + x] = 1;
  const opened = openMask(mask, w, h);
  for (let x = 0; x < w; x++) assert.equal(opened[1 * w + x], 0);
  for (let y = 4; y < 7; y++)
    for (let x = 3; x < 6; x++) assert.equal(opened[y * w + x], 1);
});
