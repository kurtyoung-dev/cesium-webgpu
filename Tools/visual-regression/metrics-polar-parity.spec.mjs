// metrics-polar-parity.spec.mjs — behaviour spec for `lib/metrics/polar-parity.mjs`.
// @purpose Behaviour spec holding the polar channel-sum parity metric to the original in-page diff of probe-polar-diff-all.mjs and to hand-derived boundary fixtures, and proving a size mismatch fails rather than reads as parity.
// @status ACTIVE
//
// TWO KINDS OF EXPECTED NUMBER, NEITHER READ BACK FROM THE MODULE.
//
//   1. The seeded cases are held to the ORIGINAL. The literals were produced
//      by running `probe-polar-diff-all.mjs`'s in-page diff body, sliced
//      verbatim from `git show a5b71fc17b:Tools/visual-regression/probe-polar-diff-all.mjs`,
//      in Node over the frames `seededPair` builds below, with only the browser
//      decode (`Image` + a 2D canvas) stubbed. The generator is banked with the
//      harvest's lane evidence (lane Edoras, `golden-from-original.mjs`).
//   2. The boundary cases are hand-derived: every literal has its arithmetic
//      in the comment beside it.
//
// On real frames the module also reproduces the banked
// `polar-multi-diff-report.json` exactly and the 2026-07-02 figures on record
// to two decimals (the metric's header says how); those frames are gitignored
// output and cannot be a spec input, so that measurement is the lane's
// receipt, not an assertion here.

import assert from "node:assert/strict";
import test from "node:test";

import {
  POLAR_PARITY_RULES,
  channelSumParity,
  insetRoi,
  polarParity,
} from "./lib/metrics/polar-parity.mjs";

const CENTRE = POLAR_PARITY_RULES["centre80-sum24"];
const FRAME = POLAR_PARITY_RULES["frame-sum30"];

/** A linear congruential generator — the same one the golden generator used. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Random RGB in A; B = A + a per-channel delta in [-spread, spread], clamped. */
function seededPair(width, height, seed, spread) {
  const rnd = lcg(seed);
  const a = new Uint8ClampedArray(width * height * 4);
  const b = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.floor(rnd() * 256);
      a[p * 4 + c] = v;
      b[p * 4 + c] = v + Math.floor(rnd() * (2 * spread + 1)) - spread;
    }
    a[p * 4 + 3] = 255;
    b[p * 4 + 3] = 255;
  }
  return { a: { width, height, data: a }, b: { width, height, data: b } };
}

/** A uniform grey frame. */
function grey(width, height, value) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function setPixel(image, x, y, r, g, b, alpha = 255) {
  const i = (y * image.width + x) * 4;
  image.data[i] = r;
  image.data[i + 1] = g;
  image.data[i + 2] = b;
  image.data[i + 3] = alpha;
}

test("centre80-sum24 reproduces the original in-page diff on two seeded pairs", () => {
  // Literals from the original body (see the header), keyed to its field
  // names: total -> countedPx, mismatch -> mismatchPx, meanDelta -> meanAbsSum,
  // meanA/meanB -> meanFirst/meanSecond.
  const golden = [
    {
      args: [40, 20, 0x5eed, 12],
      roi: { x0: 4, y0: 2, x1: 36, y1: 18 },
      countedPx: 512,
      mismatchPx: 95,
      mismatchPct: 18.5546875,
      meanAbsSum: 18.318359375,
      meanFirst: 124.998046875,
      meanSecond: 125.09375,
      brightnessRatio: 0.9992349487884087,
    },
    {
      args: [50, 30, 0xb0a7, 20],
      roi: { x0: 5, y0: 3, x1: 45, y1: 27 },
      countedPx: 960,
      mismatchPx: 660,
      mismatchPct: 68.75,
      meanAbsSum: 29.728125,
      meanFirst: 126.97048611111111,
      meanSecond: 126.82430555555555,
      brightnessRatio: 1.0011526225585483,
    },
  ];
  for (const expected of golden) {
    const { a, b } = seededPair(...expected.args);
    const got = channelSumParity(a, b, CENTRE);
    const { args, ...fields } = expected;
    assert.deepEqual(
      got,
      { width: args[0], height: args[1], ...fields },
      `seeded ${args.join("/")}`,
    );
  }
});

test("an all-black WebGPU leg reads an Infinity brightness ratio, as the original did", () => {
  // The original: brightnessRatio = meanB > 0 ? meanA / meanB : Infinity.
  const { a } = seededPair(10, 10, 7, 0);
  const black = { width: 10, height: 10, data: new Uint8ClampedArray(400) };
  const got = channelSumParity(a, black, CENTRE);
  // Literals from the original body over the same pair.
  assert.equal(got.countedPx, 64);
  assert.equal(got.mismatchPx, 64);
  assert.equal(got.mismatchPct, 100);
  assert.equal(got.meanAbsSum, 379.65625);
  assert.equal(got.meanFirst, 126.55208333333333);
  assert.equal(got.meanSecond, 0);
  assert.equal(got.brightnessRatio, Infinity);
});

test("the strict sum rule and the inset, on a hand-derived 10x10 pair", () => {
  // A is grey 100. B is A with four pixels moved:
  //   (1,1) +8/+8/+8  -> sum 24, inside the inset: not over 24, not over 30
  //   (2,1) +8/+8/+9  -> sum 25, inside: over 24 only
  //   (3,1) +10/+10/+11 -> sum 31, inside: over both
  //   (0,0) +100 each -> sum 300, OUTSIDE the 0.1 inset (x0 = y0 = 1)
  // and (4,1) differs only in alpha, which is never read.
  const a = grey(10, 10, 100);
  const b = grey(10, 10, 100);
  setPixel(b, 1, 1, 108, 108, 108);
  setPixel(b, 2, 1, 108, 108, 109);
  setPixel(b, 3, 1, 110, 110, 111);
  setPixel(b, 0, 0, 200, 200, 200);
  setPixel(b, 4, 1, 100, 100, 100, 0);

  const centre = channelSumParity(a, b, CENTRE);
  // inset 0.1 of 10: x0 = y0 = floor(1) = 1, x1 = y1 = floor(9) = 9 -> 8 x 8.
  assert.deepEqual(centre.roi, { x0: 1, y0: 1, x1: 9, y1: 9 });
  assert.equal(centre.countedPx, 64);
  assert.equal(centre.mismatchPx, 2); // the 25 and the 31
  assert.equal(centre.mismatchPct, 3.125); // 100 * 2 / 64
  assert.equal(centre.meanAbsSum, 1.25); // (24 + 25 + 31) / 64
  assert.equal(centre.meanFirst, 100);
  // B's channel sum over the inset: 64 * 300 + 80 = 19280; / (3 * 64) = 100.41666...
  assert.equal(centre.meanSecond, 19280 / 192);
  assert.equal(centre.brightnessRatio, 100 / (19280 / 192));

  const frame = channelSumParity(a, b, FRAME);
  assert.deepEqual(frame.roi, { x0: 0, y0: 0, x1: 10, y1: 10 });
  assert.equal(frame.countedPx, 100);
  assert.equal(frame.mismatchPx, 2); // the 31 and the 300; 24 and 25 are not over 30
  assert.equal(frame.mismatchPct, 2);
  assert.equal(frame.meanAbsSum, 3.8); // (24 + 25 + 31 + 300) / 100
  // B's channel sum over the frame: 100 * 300 + 380 = 30380; / 300.
  assert.equal(frame.meanSecond, 30380 / 300);
  assert.equal(frame.brightnessRatio, 100 / (30380 / 300));

  // polarParity is exactly the two rules side by side.
  assert.deepEqual(polarParity(a, b), {
    "centre80-sum24": centre,
    "frame-sum30": frame,
  });
});

test("a size mismatch throws instead of reading as parity", () => {
  const a = grey(4, 4, 10);
  const b = grey(4, 5, 10);
  assert.throws(
    () => channelSumParity(a, b, CENTRE),
    (error) =>
      error instanceof RangeError &&
      /size mismatch 4x4 vs 4x5/.test(error.message),
  );
  assert.throws(() => polarParity(a, b), RangeError);
  // A transposed frame of the same pixel count is still a mismatch.
  assert.throws(
    () => channelSumParity(grey(4, 6, 1), grey(6, 4, 1), FRAME),
    RangeError,
  );
});

test("the inset region at the banked 1280x720 frame size", () => {
  // floor(1280 * 0.1) = 128, floor(1280 * 0.9) = 1152; floor(720 * 0.1) = 72,
  // floor(720 * 0.9) = 648. The region is 1024 x 576 = 589,824 pixels — the
  // `total` the banked polar-multi-diff-report.json carries on every row.
  assert.deepEqual(insetRoi(1280, 720, 0.1), {
    x0: 128,
    y0: 72,
    x1: 1152,
    y1: 648,
  });
  assert.equal(
    channelSumParity(grey(1280, 720, 9), grey(1280, 720, 9), CENTRE).countedPx,
    589824,
  );
  assert.deepEqual(insetRoi(1280, 720, 0), { x0: 0, y0: 0, x1: 1280, y1: 720 });
  for (const bad of [0.5, -0.1, Number.NaN, "0.1", undefined]) {
    assert.throws(() => insetRoi(10, 10, bad), RangeError, String(bad));
  }
  // An inset that leaves nothing to compare is refused, not reported as 0 %.
  assert.throws(
    () =>
      channelSumParity(grey(3, 3, 1), grey(3, 3, 1), {
        threshold: 24,
        insetFraction: 0.4,
      }),
    /leaves no pixel/,
  );
});

test("the rule table is the two banked rules, frozen", () => {
  assert.deepEqual(Object.keys(POLAR_PARITY_RULES), [
    "centre80-sum24",
    "frame-sum30",
  ]);
  assert.equal(CENTRE.threshold, 24);
  assert.equal(CENTRE.insetFraction, 0.1);
  assert.equal(FRAME.threshold, 30);
  assert.equal(FRAME.insetFraction, 0);
  assert.ok(Object.isFrozen(POLAR_PARITY_RULES));
  assert.ok(Object.isFrozen(CENTRE) && Object.isFrozen(FRAME));
});

test("malformed inputs are refused", () => {
  const a = grey(4, 4, 1);
  assert.throws(() => channelSumParity(null, a, CENTRE), TypeError);
  assert.throws(
    () =>
      channelSumParity(
        { width: 4, height: 4, data: new Uint8ClampedArray(8) },
        a,
        CENTRE,
      ),
    TypeError,
  );
  for (const threshold of [-1, Number.NaN, "24", undefined]) {
    assert.throws(
      () => channelSumParity(a, a, { threshold, insetFraction: 0 }),
      RangeError,
      String(threshold),
    );
  }
});
