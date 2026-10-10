// metrics-voxel-cell-fill.spec.mjs — behaviour spec for
// `lib/metrics/voxel-cell-fill.mjs`. Pure Node: no browser, no GPU.
// @purpose Behaviour spec for the voxel per-cell window samplers and fill judgements: hand-derived fixtures plus a differential leg proving they reproduce the retired parity Part B and octree in-page code.
// @status ACTIVE
//
// The hand-derived cases check literals with a one-line derivation beside
// them. The differential cases run the retired probe code — transcribed below,
// reading pixels through a canvas `getImageData` emulator — beside the
// extracted functions over the same seeded frame and cell set, and require the
// same answers. See `metrics-voxel-footprint.spec.mjs` for why the two kinds of
// evidence are kept apart.

import assert from "node:assert/strict";
import test from "node:test";

import {
  OCTREE_FILL_THRESHOLDS,
  PARITY_FILL_THRESHOLDS,
  classifyFill,
  expectFillAtLevel,
  judgeEitherLevelFill,
  judgeExpectedFill,
  judgeLevelFill,
  windowMeanRgb,
  windowMedianRgb,
} from "./lib/metrics/voxel-cell-fill.mjs";

function frame(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function put(image, x, y, [r, g, b]) {
  const o = (y * image.width + x) * 4;
  image.data[o] = r;
  image.data[o + 1] = g;
  image.data[o + 2] = b;
  image.data[o + 3] = 255;
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function seededFrame(width, height, seed) {
  const next = seeded(seed);
  const image = frame(width, height);
  for (let i = 0; i < width * height; i++) {
    const lit = next() % 2 === 0;
    image.data[i * 4] = lit ? next() % 256 : 0;
    image.data[i * 4 + 1] = lit ? next() % 256 : 0;
    image.data[i * 4 + 2] = lit ? next() % 256 : 0;
    image.data[i * 4 + 3] = 255;
  }
  return image;
}

function getImageData(image, sx, sy, sw, sh) {
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const px = sx + x;
      const py = sy + y;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
        continue;
      }
      const from = (py * image.width + px) * 4;
      out.set(image.data.subarray(from, from + 4), (y * sw + x) * 4);
    }
  }
  return { data: out };
}

// ---------------------------------------------------------------------------
// The retired in-page code, transcribed.
// ---------------------------------------------------------------------------

/** `probe-voxel-parity.mjs` Part B: the 7 x 7 window mean per target. */
function legacyParitySample(img, pt) {
  if (!pt) {
    return null;
  }
  const x = Math.round(pt[0]);
  const y = Math.round(pt[1]);
  const half = 3;
  const d = getImageData(
    img,
    x - half,
    y - half,
    2 * half + 1,
    2 * half + 1,
  ).data;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    sr += d[i];
    sg += d[i + 1];
    sb += d[i + 2];
  }
  return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
}

/** `probe-voxel-parity.mjs` Part B's `judgeCells`, less its console line. */
function legacyParityJudge(cells) {
  let pass = true;
  for (const c of cells) {
    const lum = c.rgb ? c.rgb[0] + c.rgb[1] + c.rgb[2] : -1;
    let verdict = "skip";
    if (c.expected === "filled") {
      verdict = lum > 40 ? "ok" : "MISSING";
    } else if (c.expected === "empty") {
      verdict = lum < 25 ? "ok" : "SPURIOUS";
    }
    if (verdict === "MISSING" || verdict === "SPURIOUS") {
      pass = false;
    }
  }
  return pass;
}

/** The octree probes' median-by-luminance window sample. */
function legacyOctreeSample(img, pt, half) {
  if (!pt) return null;
  const x = Math.round(pt[0]);
  const y = Math.round(pt[1]);
  const d = getImageData(
    img,
    x - half,
    y - half,
    2 * half + 1,
    2 * half + 1,
  ).data;
  const px = [];
  for (let i = 0; i < d.length; i += 4) {
    px.push([d[i], d[i + 1], d[i + 2]]);
  }
  px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  return px[Math.floor(px.length / 2)];
}

function legacyExpectAt(c, level) {
  if (c.frac[level] >= 0.15) {
    return "filled";
  }
  if (!c.coneAny[level]) {
    return "empty";
  }
  return "skip";
}

function legacyVerdictFor(expected, lum) {
  if (expected === "filled") {
    return lum > 60 ? "ok" : "MISSING";
  }
  if (expected === "empty") {
    return lum < 40 ? "ok" : "SPURIOUS";
  }
  return "skip";
}

/** `probe-voxel-octree.mjs`'s `judgeCells` (discFamily L1/L2). */
function legacyJudgeCells(cells, level, discFamily) {
  let pass = true;
  let discriminatorsOk = 0;
  let discriminators = 0;
  for (const c of cells) {
    const expected = legacyExpectAt(c, level);
    const lum = c.rgb ? c.rgb[0] + c.rgb[1] + c.rgb[2] : -1;
    const verdict = legacyVerdictFor(expected, lum);
    const isDisc = discFamily === "L1" ? c.discL1 : c.discL2;
    if (isDisc && expected !== "skip") {
      discriminators++;
      if (verdict === "ok") discriminatorsOk++;
    }
    if (verdict === "MISSING" || verdict === "SPURIOUS") {
      pass = false;
    }
  }
  return { pass, discriminators, discriminatorsOk };
}

/** `probe-voxel-octree-l3plus.mjs`'s `judgeCellsEither(name, cells, la, lb)`. */
function legacyJudgeEither(cells, la, lb) {
  let pass = true;
  for (const c of cells) {
    const lum = c.rgb ? c.rgb[0] + c.rgb[1] + c.rgb[2] : -1;
    const va = legacyVerdictFor(legacyExpectAt(c, la), lum);
    const vb = legacyVerdictFor(legacyExpectAt(c, lb), lum);
    if (va !== "ok" && va !== "skip" && vb !== "ok" && vb !== "skip") {
      pass = false;
    }
  }
  return pass;
}

// ---------------------------------------------------------------------------
// Hand-derived cases
// ---------------------------------------------------------------------------

test("windowMeanRgb averages the full window, reading outside the frame as black", () => {
  const image = frame(4, 4);
  put(image, 0, 0, [90, 9, 0]);
  // Centre (0.4, 0.4) rounds to (0,0); half 1 -> 3 x 3 = 9 pixels, 5 of them
  // outside the frame and read as black: (90/9, 9/9, 0) = (10, 1, 0).
  assert.deepEqual(windowMeanRgb(image, [0.4, 0.4], 1), [10, 1, 0]);
  // Centre (3,3), half 1: one lit pixel of blue 5 among 9 (four in frame,
  // five beyond the edge) -> 5 / 9 = 0.56 -> Math.round -> 1, not a floor to 0.
  put(image, 3, 3, [0, 0, 5]);
  assert.deepEqual(windowMeanRgb(image, [3, 3], 1), [0, 0, 1]);
  assert.equal(windowMeanRgb(image, null, 1), null);
});

test("windowMedianRgb takes the middle pixel by r+g+b, black outside the frame", () => {
  const image = frame(3, 3);
  put(image, 0, 0, [200, 200, 200]); // lum 600
  put(image, 1, 0, [10, 10, 10]); // lum 30
  put(image, 2, 0, [50, 0, 0]); // lum 50
  // Centre (1,0), half 1: 9 window pixels, 3 above the frame (black), the
  // top row (600, 30, 50) and the rest black -> sorted lums
  // [0,0,0,0,0,0,30,50,600]; the median (index 4) is black.
  assert.deepEqual(windowMedianRgb(image, [1, 0], 1), [0, 0, 0]);
  const lit = frame(3, 3);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      put(lit, x, y, [x * 10 + y, 0, 0]); // lums 0,10,20,1,11,21,2,12,22
    }
  }
  // Sorted: 0,1,2,10,11,12,20,21,22 -> index 4 is 11 = (x=1, y=1).
  assert.deepEqual(windowMedianRgb(lit, [1, 1], 1), [11, 0, 0]);
});

test("classifyFill is strict at both bars", () => {
  const bars = { filledAbove: 40, emptyBelow: 25 };
  assert.equal(classifyFill("filled", 41, bars), "ok");
  assert.equal(classifyFill("filled", 40, bars), "MISSING");
  assert.equal(classifyFill("empty", 24, bars), "ok");
  assert.equal(classifyFill("empty", 25, bars), "SPURIOUS");
  assert.equal(classifyFill("skip", 999, bars), "skip");
  // No sample reads -1: MISSING if expected filled, ok if expected empty.
  assert.equal(classifyFill("filled", -1, bars), "MISSING");
  assert.equal(classifyFill("empty", -1, bars), "ok");
  assert.deepEqual(PARITY_FILL_THRESHOLDS, bars);
  assert.deepEqual(OCTREE_FILL_THRESHOLDS, { filledAbove: 60, emptyBelow: 40 });
});

test("expectFillAtLevel: solid centre ray is filled, an all-miss cone is empty, the rest skip", () => {
  const cell = { frac: [0.15, 0.1, 0], coneAny: [true, true, false] };
  assert.equal(expectFillAtLevel(cell, 0), "filled"); // 0.15 >= 0.15
  assert.equal(expectFillAtLevel(cell, 1), "skip"); // 0.1, cone touched
  assert.equal(expectFillAtLevel(cell, 2), "empty"); // cone missed
});

test("judgeLevelFill counts discriminators that are judged and reads each against the level", () => {
  const cells = [
    // filled at level 2, lit: ok; discriminator judged and ok
    {
      label: "a",
      frac: [1, 1, 0.5],
      coneAny: [1, 1, 1],
      rgb: [30, 30, 30],
      discL1: true,
    },
    // empty at level 2, black: ok; discriminator judged and ok
    {
      label: "b",
      frac: [1, 1, 0],
      coneAny: [1, 1, false],
      rgb: [0, 0, 0],
      discL1: true,
    },
    // skip at level 2: never judged, even as a discriminator
    {
      label: "c",
      frac: [1, 1, 0.1],
      coneAny: [1, 1, 1],
      rgb: [0, 0, 0],
      discL1: true,
    },
    // empty at level 2 but lit: SPURIOUS, not a discriminator
    {
      label: "d",
      frac: [0, 0, 0],
      coneAny: [0, 0, false],
      rgb: [20, 20, 1],
      discL1: false,
    },
  ];
  const result = judgeLevelFill(cells, { level: 2, discriminator: "discL1" });
  assert.equal(result.pass, false); // cell d: lum 41 is not below 40
  assert.equal(result.discriminators, 2); // a and b; c skipped
  assert.equal(result.discriminatorsOk, 2);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /^d L2-expect=empty rgb=20,20,1 SPURIOUS$/);
});

test("judgeEitherLevelFill fails a cell only when both levels call it a hard miss", () => {
  const cells = [
    // empty at 1, filled at 2, black -> vsL1 ok -> passes
    { label: "x", frac: [0, 0, 0.5], coneAny: [0, false, 1], rgb: [0, 0, 0] },
    // filled at both, black -> MISSING twice -> fails
    { label: "y", frac: [0, 0.5, 0.5], coneAny: [0, 1, 1], rgb: [0, 0, 0] },
  ];
  const result = judgeEitherLevelFill(cells, { levels: [1, 2] });
  assert.equal(result.pass, false);
  assert.deepEqual(result.failures, ["y rgb=0,0,0 vsL1=MISSING vsL2=MISSING"]);
});

test("judgeExpectedFill reads the precomputed expectation with the parity bars", () => {
  const result = judgeExpectedFill([
    { label: "y0z0", expected: "filled", rgb: [20, 20, 1] }, // 41 > 40: ok
    { label: "y0z2", expected: "empty", rgb: [8, 8, 8] }, // 24 < 25: ok
    { label: "y1z0", expected: "skip", rgb: null },
  ]);
  assert.equal(result.pass, true);
  assert.deepEqual(result.rows, [
    "y0z0 expect=filled rgb=20,20,1 ok",
    "y0z2 expect=empty rgb=8,8,8 ok",
    "y1z0 expect=skip rgb=? skip",
  ]);
  assert.equal(
    judgeExpectedFill([{ label: "e", expected: "empty", rgb: [9, 8, 8] }]).pass,
    false,
  );
});

// ---------------------------------------------------------------------------
// Differential cases
// ---------------------------------------------------------------------------

test("DIFFERENTIAL: window samplers equal the retired parity and octree samplers", () => {
  const img = seededFrame(96, 64, 42);
  const next = seeded(9);
  for (let i = 0; i < 400; i++) {
    // Points inside, on and beyond every edge, with fractional coordinates.
    const pt = [(next() % 1100) / 10 - 5, (next() % 760) / 10 - 5];
    const half = 1 + (next() % 3);
    assert.deepEqual(windowMeanRgb(img, pt, 3), legacyParitySample(img, pt));
    assert.deepEqual(
      windowMedianRgb(img, pt, half),
      legacyOctreeSample(img, pt, half),
    );
  }
});

test("DIFFERENTIAL: fill judgements equal the retired judgeCells / judgeCellsEither", () => {
  const next = seeded(77);
  const pick = (values) => values[next() % values.length];
  for (let trial = 0; trial < 200; trial++) {
    const cells = [];
    for (let i = 0; i < 24; i++) {
      const frac = [0, 1, 2, 3].map(() => pick([0, 0.05, 0.14, 0.15, 0.5]));
      const coneAny = [0, 1, 2, 3].map(() => next() % 2 === 0);
      const lum = pick([-1, 0, 24, 25, 39, 40, 41, 60, 61, 200]);
      cells.push({
        label: `c${i}`,
        frac,
        coneAny,
        rgb: lum < 0 ? null : [lum, 0, 0],
        discL1: next() % 2 === 0,
        discL2: next() % 2 === 0,
        expected: pick(["filled", "empty", "skip"]),
      });
    }
    for (const [level, family] of [
      [2, "L1"],
      [2, "L2"],
    ]) {
      const legacy = legacyJudgeCells(cells, level, family);
      const extracted = judgeLevelFill(cells, {
        level,
        discriminator: `disc${family}`,
      });
      assert.equal(extracted.pass, legacy.pass);
      assert.equal(extracted.discriminators, legacy.discriminators);
      assert.equal(extracted.discriminatorsOk, legacy.discriminatorsOk);
    }
    assert.equal(
      judgeEitherLevelFill(cells, { levels: [2, 3] }).pass,
      legacyJudgeEither(cells, 2, 3),
    );
    assert.equal(judgeExpectedFill(cells).pass, legacyParityJudge(cells));
  }
});
