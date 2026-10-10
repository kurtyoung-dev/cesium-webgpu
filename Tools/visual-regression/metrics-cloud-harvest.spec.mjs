// metrics-cloud-harvest.spec.mjs — the four metric modules the cloud family's
// probe-kit harvest (round 1) extracted. Pure Node: no browser, no GPU.
//
// @purpose Pins lib/metrics luma-difference, deck-region, cloud-band and aerial-blend against small hand-built RGBA frames whose answers are worked by hand in the comments, including every strict threshold, the floored fractional region and each empty case.
// @status ACTIVE
//
// WHERE THE EXPECTED NUMBERS COME FROM. Not from the modules: every expected
// value below is worked from the pixel values in its own comment, so a module
// that drifted from the in-page arithmetic it replaced (a Rec. 709 weight, a
// non-strict threshold, a rounded region edge) fails here rather than agreeing
// with itself. Floating-point expectations are compared to 1e-9, which is far
// below any bar the probes apply (their tightest is 0.25 levels of luma) and
// far above the last-bit noise of a reordered sum.

import assert from "node:assert/strict";
import test from "node:test";

import {
  REC601_LUMA_WEIGHTS,
  meanAbsLumaDifference,
  rec601Luma,
} from "./lib/metrics/luma-difference.mjs";
import {
  changedPixelChromaShift,
  fractionRoi,
  greyDeckFraction,
  roiMeanLuma,
} from "./lib/metrics/deck-region.mjs";
import { bandQuantile, cloudBandStats } from "./lib/metrics/cloud-band.mjs";
import { aerialBlendCoefficient } from "./lib/metrics/aerial-blend.mjs";

const near = (actual, expected, message) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );

/**
 * A decoded-RGBA frame filled with one colour, with per-pixel overrides.
 *
 * @param {number} width Width.
 * @param {number} height Height.
 * @param {number[]} fill RGB fill.
 * @param {Array<[number, number, number[]]>} [pixels] `[x, y, [r, g, b]]` overrides.
 * @returns {{width: number, height: number, data: Uint8Array}} The frame.
 */
function frame(width, height, fill, pixels = []) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([...fill, 255], i * 4);
  }
  for (const [x, y, rgb] of pixels) {
    data.set([...rgb, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------
// luma-difference
// ---------------------------------------------------------------------------

test("L1: Rec. 601 weights, not Rec. 709", () => {
  assert.deepEqual(REC601_LUMA_WEIGHTS, { r: 0.299, g: 0.587, b: 0.114 });
  near(rec601Luma(100, 0, 0), 29.9, "pure red 100");
  near(rec601Luma(0, 100, 0), 58.7, "pure green 100");
  near(rec601Luma(0, 0, 100), 11.4, "pure blue 100");
  // A Rec. 709 weighting would give 71.52 here.
  assert.ok(Math.abs(rec601Luma(0, 100, 0) - 71.52) > 1);
});

test("L2: mean absolute luma difference averages over EVERY pixel", () => {
  // 2x2, one pixel moves from black to green 100: luma 58.7 over 4 pixels.
  const a = frame(2, 2, [0, 0, 0]);
  const b = frame(2, 2, [0, 0, 0], [[1, 1, [0, 100, 0]]]);
  near(meanAbsLumaDifference(a, b), 58.7 / 4, "one moved pixel");
  near(meanAbsLumaDifference(b, a), 58.7 / 4, "symmetric");
  // Opposite-signed moves do not cancel: +29.9 and -29.9 give 59.8 / 4.
  const c = frame(2, 2, [50, 50, 50], [[0, 0, [150, 50, 50]]]);
  const d = frame(2, 2, [50, 50, 50], [[1, 0, [150, 50, 50]]]);
  near(meanAbsLumaDifference(c, d), (29.9 + 29.9) / 4, "no cancellation");
  assert.equal(meanAbsLumaDifference(a, a), 0, "identical frames are 0");
});

test("L3: a pair that cannot be compared pixel for pixel is refused, by every two-frame measure", () => {
  assert.throws(
    () => meanAbsLumaDifference(frame(2, 2, [0, 0, 0]), frame(3, 2, [0, 0, 0])),
    TypeError,
  );
  assert.throws(() => meanAbsLumaDifference(frame(2, 2, [0, 0, 0]), null));
  // The other two two-frame measures refuse by name too, rather than reading
  // misaligned rows into a finite answer (pass-2 advisory A1). The larger
  // frame is the second one, so a measure without the refusal would read in
  // bounds and return a number.
  const whole = { x0: 0, x1: 1, y0: 0, y1: 1 };
  assert.throws(
    () =>
      changedPixelChromaShift(
        frame(2, 2, [100, 100, 100]),
        frame(3, 2, [200, 200, 200]),
        whole,
      ),
    (error) =>
      error instanceof TypeError &&
      /changedPixelChromaShift/.test(error.message),
  );
  assert.throws(
    () =>
      aerialBlendCoefficient(
        frame(2, 2, [100, 100, 100]),
        frame(3, 2, [200, 200, 200]),
        [1, 1, 1],
      ),
    (error) =>
      error instanceof TypeError &&
      /aerialBlendCoefficient/.test(error.message),
  );
  // Pass-3 advisory A5: a transposed pair (2x3 against 3x2) has buffers of
  // the same length, so only the width and height comparisons refuse it.
  // Every two-frame measure must still refuse it by name.
  const tall = frame(2, 3, [100, 100, 100]);
  const wide = frame(3, 2, [200, 200, 200]);
  assert.equal(tall.data.length, wide.data.length, "same buffer length");
  // Pass-4 observation O1: the width comparison alone cannot refuse a pair
  // whose widths match, so the height comparison needs its own case. The
  // second frame declares 2x2 over a buffer 2x3 long: its length equals the
  // first frame's and the first frame is consistent with its own size, so
  // only the height comparison refuses it.
  const lying = { width: 2, height: 2, data: new Uint8Array(2 * 3 * 4) };
  assert.equal(tall.width, lying.width, "same width");
  assert.notEqual(tall.height, lying.height, "different height");
  assert.equal(tall.data.length, lying.data.length, "same buffer length");
  for (const [left, right] of [
    [tall, wide],
    [tall, lying],
  ]) {
    for (const [what, measure] of [
      ["meanAbsLumaDifference", () => meanAbsLumaDifference(left, right)],
      [
        "changedPixelChromaShift",
        () => changedPixelChromaShift(left, right, whole),
      ],
      [
        "aerialBlendCoefficient",
        () => aerialBlendCoefficient(left, right, [1, 1, 1]),
      ],
    ]) {
      assert.throws(
        measure,
        (error) => error instanceof TypeError && error.message.startsWith(what),
        what,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// deck-region
// ---------------------------------------------------------------------------

const DEMO_DECK = Object.freeze({ x0: 0.42, x1: 0.95, y0: 0.08, y1: 0.86 });

test("R1: the fractional region is floored and half-open, as getImageData read it", () => {
  // 10 wide: floor(4.2) = 4 .. floor(9.5) = 9; 10 high: floor(0.8) = 0 .. floor(8.6) = 8.
  assert.deepEqual(fractionRoi({ width: 10, height: 10 }, DEMO_DECK), {
    x0: 4,
    y0: 0,
    x1: 9,
    y1: 8,
  });
  // 1024x768, the probes' own frame: 430..972 by 61..660.
  assert.deepEqual(fractionRoi({ width: 1024, height: 768 }, DEMO_DECK), {
    x0: 430,
    y0: 61,
    x1: 972,
    y1: 660,
  });
  // 7x7, where flooring and rounding part on three edges (pass-2 advisory
  // A2): 2.94 -> 2 (not 3), 0.56 -> 0 (not 1), 6.65 -> 6 (not 7); 6.02 -> 6.
  assert.deepEqual(fractionRoi({ width: 7, height: 7 }, DEMO_DECK), {
    x0: 2,
    y0: 0,
    x1: 6,
    y1: 6,
  });
});

test("R2: the region's mean luma reads only the region", () => {
  // 4x4 black with a 2x2 block of grey 100 at x 2..3, y 2..3, and a white pixel
  // OUTSIDE the region at (0, 0) that must not be read. Region x 0.5..1,
  // y 0.5..1 = exactly that block: mean luma 100.
  const image = frame(
    4,
    4,
    [0, 0, 0],
    [
      [2, 2, [100, 100, 100]],
      [3, 2, [100, 100, 100]],
      [2, 3, [100, 100, 100]],
      [3, 3, [100, 100, 100]],
      [0, 0, [255, 255, 255]],
    ],
  );
  near(roiMeanLuma(image, { x0: 0.5, x1: 1, y0: 0.5, y1: 1 }), 100, "block");
  // x 0.5..0.75 is one column (x = 2) over every row: two black pixels and
  // two grey ones, so the mean is 50.
  near(roiMeanLuma(image, { x0: 0.5, x1: 0.75, y0: 0, y1: 1 }), 50, "column");
});

test("R3: grey deck fraction applies each threshold strictly", () => {
  // 5x1 strip, region = the whole strip:
  //   (91,91,91)   luma 90.999, spread 0   -> cloud
  //   (90,90,90)   luma 90 exactly          -> NOT cloud (strict floor)
  //   (150,100,100) luma 114.95, spread 50 -> NOT cloud (strict ceiling)
  //   (100,120,200) blue sky (200 > 125, 200 > 120) -> NOT cloud
  //   (150,110,110) luma 121.96, spread 40 -> cloud
  // 2 of 5 = 40 %.
  const strip = frame(
    5,
    1,
    [0, 0, 0],
    [
      [0, 0, [91, 91, 91]],
      [1, 0, [90, 90, 90]],
      [2, 0, [150, 100, 100]],
      [3, 0, [100, 120, 200]],
      [4, 0, [150, 110, 110]],
    ],
  );
  const whole = { x0: 0, x1: 1, y0: 0, y1: 1 };
  near(greyDeckFraction(strip, whole), 40, "demo thresholds");
  // The blue-sky pixel has spread 100 and still fails the chroma ceiling, so
  // switching the exclusion off changes nothing here; a pale blue pixel
  // that passes luma and chroma does move with it: (130,150,166) is
  // b > r + 25 and b > 120, luma 145.844, spread 36.
  const pale = frame(1, 1, [130, 150, 166]);
  near(greyDeckFraction(pale, whole), 0, "blue sky excluded");
  near(
    greyDeckFraction(pale, whole, { excludeBlueSky: false }),
    100,
    "blue sky kept when asked",
  );
  // Both blue-sky bars are strict (pass-2 advisory A2). (110,120,135) has
  // b = r + 25 exactly (luma 118.72, spread 25): grey cloud. (110,120,136) is
  // one level past it: blue sky. (90,115,120) has b > r + 25 but b = 120
  // exactly (luma 108.095, spread 30): grey cloud.
  near(
    greyDeckFraction(frame(1, 1, [110, 120, 135]), whole),
    100,
    "b = r + 25",
  );
  near(greyDeckFraction(frame(1, 1, [110, 120, 136]), whole), 0, "b = r + 26");
  near(greyDeckFraction(frame(1, 1, [90, 115, 120]), whole), 100, "b = 120");
  // The depth-occlusion probe's whitish test: luma > 150, spread < 40.
  const bright = frame(
    2,
    1,
    [0, 0, 0],
    [
      [0, 0, [151, 151, 151]],
      [1, 0, [150, 150, 150]],
    ],
  );
  near(
    greyDeckFraction(bright, whole, {
      minLuma: 150,
      maxChroma: 40,
      excludeBlueSky: false,
    }),
    50,
    "whitish",
  );
});

test("R4: changed-pixel chroma shift reads only pixels whose luma moved past the bar", () => {
  // 3x1, region = whole strip, before all grey 100.
  //   px0 -> (80,100,160): dr -20, dg 0, db +60, luma delta -5.98+6.84 = 0.86 -> NOT counted
  //   px1 -> (100,100,200): db +100, luma delta 11.4 -> counted (dr 0, db 100)
  //   px2 -> (60,100,100): dr -40, luma delta -11.96 -> counted (dr -40, db 0)
  // mean dr = -20, mean db = 50, cool = (100 - (-40)) / 2 = 70.
  const before = frame(3, 1, [100, 100, 100]);
  const after = frame(
    3,
    1,
    [100, 100, 100],
    [
      [0, 0, [80, 100, 160]],
      [1, 0, [100, 100, 200]],
      [2, 0, [60, 100, 100]],
    ],
  );
  const whole = { x0: 0, x1: 1, y0: 0, y1: 1 };
  const shift = changedPixelChromaShift(before, after, whole);
  assert.equal(shift.n, 2);
  near(shift.dr, -20, "dr");
  near(shift.db, 50, "db");
  near(shift.cool, 70, "cool");
  // Outside the region nothing counts: x 0..0.34 is px0 only (floor(1.02) = 1).
  assert.deepEqual(
    changedPixelChromaShift(before, after, { x0: 0, x1: 0.34, y0: 0, y1: 1 }),
    { dr: 0, db: 0, cool: 0, n: 0 },
  );
  // A lower bar admits px0 too: n 3, db (60 + 100 + 0) / 3.
  const loose = changedPixelChromaShift(before, after, whole, {
    lumaDelta: 0.5,
  });
  assert.equal(loose.n, 3);
  near(loose.db, 160 / 3, "loose db");
});

test("R5: a luma move of exactly the bar does not count (the bar is strict)", () => {
  // grey 100 -> grey 110: dr = dg = db = 10, and rec601Luma(10, 10, 10) is
  // exactly 10 in floating point, so the pixel sits ON the default bar.
  const before = frame(1, 1, [100, 100, 100]);
  const onTheBar = frame(1, 1, [110, 110, 110]);
  const whole = { x0: 0, x1: 1, y0: 0, y1: 1 };
  assert.deepEqual(changedPixelChromaShift(before, onTheBar, whole), {
    dr: 0,
    db: 0,
    cool: 0,
    n: 0,
  });
  // One level past it counts.
  assert.equal(
    changedPixelChromaShift(before, frame(1, 1, [111, 111, 111]), whole).n,
    1,
  );
});

// ---------------------------------------------------------------------------
// cloud-band
// ---------------------------------------------------------------------------

test("B1: only the upper band's pixels above the floor are cloud", () => {
  // 2x10: bandRows = floor(10 * 0.6) = 6, so rows 0..5 are read.
  //   row 0: (30,30,60) max 60, (24,24,24) max 24 -> NOT cloud (strict)
  //   row 1: (100,50,50) max 100
  //   row 3: (25,0,0) max 25
  //   row 5: (0,0,200) max 200
  //   row 7: (255,255,255) -> below the band, NOT read
  const image = frame(
    2,
    10,
    [0, 0, 0],
    [
      [0, 0, [30, 30, 60]],
      [1, 0, [24, 24, 24]],
      [0, 1, [100, 50, 50]],
      [1, 3, [25, 0, 0]],
      [0, 5, [0, 0, 200]],
      [1, 7, [255, 255, 255]],
    ],
  );
  const stats = cloudBandStats(image);
  assert.equal(stats.bandRows, 6);
  assert.equal(stats.count, 4);
  assert.deepEqual([...stats.sortedMaxChannel], [25, 60, 100, 200]);
  assert.equal(stats.sumR, 30 + 100 + 25 + 0);
  assert.equal(stats.sumG, 30 + 50 + 0 + 0);
  assert.equal(stats.sumB, 60 + 50 + 0 + 200);
  // Top rows y < 2.4 (rows 0-2): (30,30,60) blue 0.5 and (100,50,50) blue 0.25.
  near(stats.topBlueRatio, (0.5 + 0.25) / 2, "top blue ratio");
  assert.equal(stats.topCount, 2);
  // Bottom rows y > 3.6 (rows 4-5): (0,0,200) blue 1. Row 3 is in neither.
  near(stats.bottomBlueRatio, 1, "bottom blue ratio");
  assert.equal(stats.bottomCount, 1);
});

test("B2: the floor and the band are options, and an empty band is zeros", () => {
  const image = frame(1, 10, [0, 0, 0], [[0, 8, [90, 90, 90]]]);
  assert.equal(cloudBandStats(image).count, 0);
  assert.equal(cloudBandStats(image, { bandFraction: 1 }).count, 1);
  assert.equal(
    cloudBandStats(image, { bandFraction: 1, minMaxChannel: 90 }).count,
    0,
  );
  const empty = cloudBandStats(image);
  assert.equal(empty.topBlueRatio, 0);
  assert.equal(empty.bottomBlueRatio, 0);
  assert.throws(() => cloudBandStats({ width: 2, height: 2, data: [] }));
});

test("B3: quantiles index the ascending values at floor(length * q)", () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(bandQuantile(sorted, 0.1), 20);
  assert.equal(bandQuantile(sorted, 0.5), 60);
  assert.equal(bandQuantile(sorted, 0.95), 100);
  assert.equal(bandQuantile([], 0.5), undefined);
});

test("B4: a fractional quantile index floors, and the blue-ratio rows split exactly at 0.4 and 0.6 of the band", () => {
  // Seven values: 7 * 0.5 = 3.5 and 7 * 0.1 = 0.7 are not integers, so the
  // index rule (floor, as the in-page copies indexed) is what decides.
  const seven = [1, 2, 3, 4, 5, 6, 7];
  assert.equal(bandQuantile(seven, 0.5), 4);
  assert.equal(bandQuantile(seven, 0.1), 1);
  // 1x25: bandRows = floor(25 * 0.6) = 15, so the top rows are y < 6 and the
  // bottom rows y > 9, both boundaries exact integers in floating point.
  //   row 5 -> top, row 6 -> neither, row 9 -> neither, row 10 -> bottom.
  const image = frame(
    1,
    25,
    [0, 0, 0],
    [
      [0, 5, [0, 0, 100]],
      [0, 6, [100, 0, 0]],
      [0, 9, [0, 100, 0]],
      [0, 10, [50, 0, 50]],
    ],
  );
  const stats = cloudBandStats(image);
  assert.equal(stats.bandRows, 15);
  assert.equal(stats.count, 4);
  assert.equal(stats.topCount, 1);
  near(stats.topBlueRatio, 1, "top: row 5 only");
  assert.equal(stats.bottomCount, 1);
  near(stats.bottomBlueRatio, 0.5, "bottom: row 10 only");
});

test("B5: a fractional band height floors, so a 9-row frame reads 5 rows and not 6", () => {
  // Pass-3 advisory A4. 1x9: bandRows = floor(9 * 0.6) = floor(5.4) = 5, so
  // rows 0-4 are read. Row 4 (100, 100, 100) is cloud; row 5
  // (200, 200, 200) is below the band and is NOT read (a ceiling would read
  // 6 rows and count it). Every other frame in this file has an integer band.
  const image = frame(
    1,
    9,
    [0, 0, 0],
    [
      [0, 4, [100, 100, 100]],
      [0, 5, [200, 200, 200]],
    ],
  );
  const stats = cloudBandStats(image);
  assert.equal(stats.bandRows, 5);
  assert.equal(stats.count, 1);
  assert.deepEqual([...stats.sortedMaxChannel], [100]);
  assert.equal(stats.sumR, 100);
});

// ---------------------------------------------------------------------------
// aerial-blend
// ---------------------------------------------------------------------------

test("A1: halfway to the reference is a coefficient of one half", () => {
  // OFF cloud (100,100,100), ON (178,178,178), reference 256 per channel:
  // the OFF mean is 156 levels (per channel) from the reference and the ON
  // mean moved 78 of them, so a = 78 / 156.
  const off = frame(2, 1, [0, 0, 0], [[0, 0, [100, 100, 100]]]);
  const on = frame(2, 1, [0, 0, 0], [[0, 0, [178, 178, 178]]]);
  const reference = [256 / 255, 256 / 255, 256 / 255];
  const blend = aerialBlendCoefficient(off, on, reference);
  assert.equal(blend.cloud, 1, "the black pixel is below the floor in both");
  near(blend.a, 0.5, "coefficient");
  near(blend.meanOff[0], 100 / 255, "mean off");
  near(blend.meanOn[0], 178 / 255, "mean on");
});

test("A2: a pixel bright in EITHER frame counts, one dark in both does not", () => {
  // px0 dark in OFF (luma 0) but lit in ON (luma 60): counted.
  // px1 (39,39,39) in both: luma 39 < 40, not counted.
  const off = frame(
    2,
    1,
    [0, 0, 0],
    [
      [0, 0, [0, 0, 0]],
      [1, 0, [39, 39, 39]],
    ],
  );
  const on = frame(
    2,
    1,
    [0, 0, 0],
    [
      [0, 0, [60, 60, 60]],
      [1, 0, [39, 39, 39]],
    ],
  );
  const blend = aerialBlendCoefficient(off, on, [1, 1, 1]);
  assert.equal(blend.cloud, 1);
  // meanOff 0, meanOn 60, ref 255: a = (60 * sqrt 3) / (255 * sqrt 3).
  near(blend.a, 60 / 255, "coefficient");
});

test("A3: the row window, the ill-conditioned guard and the empty frame", () => {
  const off = frame(1, 4, [0, 0, 0], [[0, 3, [100, 100, 100]]]);
  const on = frame(1, 4, [0, 0, 0], [[0, 3, [200, 200, 200]]]);
  // Rows [floor(4 * 0), floor(4 * 0.5)) = rows 0-1: the only lit row is 3.
  assert.deepEqual(aerialBlendCoefficient(off, on, [1, 1, 1], { y1: 0.5 }), {
    cloud: 0,
  });
  // A reference within one level of the OFF mean reports 0, not a blow-up.
  const guarded = aerialBlendCoefficient(off, on, [
    100 / 255,
    100 / 255,
    100 / 255,
  ]);
  assert.equal(guarded.cloud, 1);
  assert.equal(guarded.a, 0);
});

test("A4: a pixel of luma exactly the floor counts, and a reference under one level away is guarded", () => {
  // rec601Luma(40, 40, 40) is exactly 40: the floor excludes only what is
  // BELOW it, so a pixel at 40 in BOTH frames is cloud.
  const off = frame(1, 1, [40, 40, 40]);
  assert.equal(aerialBlendCoefficient(off, off, [1, 1, 1]).cloud, 1);
  const on = frame(1, 1, [60, 60, 60]);
  // A reference half a level from the OFF mean is inside the guard (distance
  // not above 1), so the coefficient is 0 rather than 20 / 0.5.
  const halfLevel = aerialBlendCoefficient(off, on, [
    40.5 / 255,
    40 / 255,
    40 / 255,
  ]);
  assert.equal(halfLevel.cloud, 1);
  assert.equal(halfLevel.a, 0);
});
