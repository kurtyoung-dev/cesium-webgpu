// metrics-voxel-footprint.spec.mjs — behaviour spec for
// `lib/metrics/voxel-footprint.mjs`. Pure Node: no browser, no GPU.
// @purpose Behaviour spec for the voxel footprint metrics: hand-derived fixtures for every function, plus a differential leg proving each reproduces the pre-migration in-page arithmetic on the same frame.
// @status ACTIVE
//
// TWO KINDS OF EVIDENCE, KEPT APART.
//
// The hand-derived cases put small frames in front of each function and check
// literals whose derivation is a one-line comment beside them — never a call
// back into the module under test.
//
// The DIFFERENTIAL cases answer a different question: did the extraction change
// a number? Before the harvest, six voxel probes computed these statistics
// inside the page, over a canvas the screenshot was drawn into. That code is
// transcribed below as `legacy*` functions, reading pixels through a
// `getImageData` emulator with the canvas semantics the page had (a pixel
// outside the canvas reads transparent black, and a zero width or height
// throws `IndexSizeError`, HTML `getImageData` step 1). Both paths run over
// the same seeded frame and must agree exactly. The transcription is a copy of the
// retired code, not of the new module, so the two are independent sources.

import assert from "node:assert/strict";
import test from "node:test";

import { spread } from "./lib/determinism-kit.mjs";
import {
  VOXEL_PARITY_REGION,
  colourL1,
  cropMeanAbsDifference,
  footprintGrid,
  fractionalRegion,
  framePairRegionDifference,
  interiorCellColourMatch,
  maskIoU,
  regionColourStats,
  regionRgbValues,
} from "./lib/metrics/voxel-footprint.mjs";

/** A black RGBA frame. */
function frame(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Paint one pixel. */
function put(image, x, y, [r, g, b]) {
  const o = (y * image.width + x) * 4;
  image.data[o] = r;
  image.data[o + 1] = g;
  image.data[o + 2] = b;
  image.data[o + 3] = 255;
}

/** A deterministic pseudo-random frame (LCG), mixing black and lit pixels. */
function seededFrame(width, height, seed) {
  const image = frame(width, height);
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let i = 0; i < width * height; i++) {
    const lit = next() % 3 !== 0;
    const o = i * 4;
    image.data[o] = lit ? next() % 256 : next() % 5;
    image.data[o + 1] = lit ? next() % 256 : next() % 5;
    image.data[o + 2] = lit ? next() % 256 : next() % 5;
    image.data[o + 3] = 255;
  }
  return image;
}

/** `CanvasRenderingContext2D.getImageData` over a decoded frame. */
function getImageData(image, sx, sy, sw, sh) {
  if (sw === 0 || sh === 0) {
    // What a browser does with a zero extent; it never returns empty data.
    const error = new Error("getImageData: the source width is 0.");
    error.name = "IndexSizeError";
    throw error;
  }
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const px = sx + x;
      const py = sy + y;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
        continue;
      }
      const from = (py * image.width + px) * 4;
      const to = (y * sw + x) * 4;
      out[to] = image.data[from];
      out[to + 1] = image.data[from + 1];
      out[to + 2] = image.data[from + 2];
      out[to + 3] = image.data[from + 3];
    }
  }
  return { data: out };
}

// ---------------------------------------------------------------------------
// The retired in-page arithmetic, transcribed. `ctx.getImageData` is the
// emulator above; every other line is the probe's own.
// ---------------------------------------------------------------------------

/** `probe-voxel-parity.mjs` Part A / ellipsoid / user-customshader `px`. */
function legacyParityPx(img) {
  const w = img.width;
  const h = img.height;
  const rx = Math.floor(w * 0.2);
  const ry = Math.floor(h * 0.2);
  const rw = Math.floor(w * 0.55);
  const rh = Math.floor(h * 0.6);
  const d = getImageData(img, rx, ry, rw, rh).data;
  const GW = 64;
  const GH = 48;
  const mask = new Uint8Array(GW * GH);
  const cellRGB = new Array(GW * GH).fill(null);
  const colorSet = new Set();
  let nonBlack = 0;
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const sx = rx + Math.floor((gx / GW) * rw);
      const sy = ry + Math.floor((gy / GH) * rh);
      const dd = getImageData(img, sx, sy, 1, 1).data;
      const lum = dd[0] + dd[1] + dd[2];
      if (lum > 20) {
        mask[gy * GW + gx] = 1;
        cellRGB[gy * GW + gx] = [dd[0], dd[1], dd[2]];
        nonBlack++;
        colorSet.add(`${dd[0] >> 5}_${dd[1] >> 5}_${dd[2] >> 5}`);
      }
    }
  }
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] + d[i + 1] + d[i + 2];
    if (lum > 20) {
      sr += d[i];
      sg += d[i + 1];
      sb += d[i + 2];
      n++;
    }
  }
  const nn = Math.max(1, n);
  return {
    mask: Array.from(mask),
    cellRGB,
    maskCells: nonBlack,
    distinctColors: colorSet.size,
    avgColor: [Math.round(sr / nn), Math.round(sg / nn), Math.round(sb / nn)],
    coveragePct: (n / (d.length / 4)) * 100,
  };
}

/** The ellipsoid/cylinder interior per-cell colour comparison. */
function legacyInteriorMatch(a, b, ca, cb) {
  const GW = 64;
  const GH = 48;
  let interiorCells = 0;
  let matchedCells = 0;
  let distSum = 0;
  const glR = [];
  const glG = [];
  for (let gy = 1; gy < GH - 1; gy++) {
    for (let gx = 1; gx < GW - 1; gx++) {
      const idx = gy * GW + gx;
      const nbr = [idx - 1, idx + 1, idx - GW, idx + GW];
      const interior =
        a[idx] && b[idx] && nbr.every((nIdx) => a[nIdx] && b[nIdx]);
      if (!interior) continue;
      const x = ca[idx];
      const y = cb[idx];
      if (!x || !y) continue;
      interiorCells++;
      glR.push(x[0]);
      glG.push(x[1]);
      const dist = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
      distSum += dist;
      if (dist < 60) matchedCells++;
    }
  }
  const stddev = (arr) => {
    if (arr.length === 0) return 0;
    const m = arr.reduce((s, x) => s + x, 0) / arr.length;
    return Math.sqrt(
      arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length,
    );
  };
  return {
    interiorCells,
    matchedCells,
    matchFrac: interiorCells > 0 ? matchedCells / interiorCells : 0,
    meanDist: interiorCells > 0 ? distSum / interiorCells : 999,
    glSpread: stddev(glR) + stddev(glG),
  };
}

/** `probe-voxel-megatexture.mjs` PART 1 `px`. */
function legacyMegatexturePx(img) {
  const w = img.width;
  const h = img.height;
  const rx = Math.floor(w * 0.28);
  const ry = Math.floor(h * 0.28);
  const rw = Math.floor(w * 0.4);
  const rh = Math.floor(h * 0.4);
  const d = getImageData(img, rx, ry, rw, rh).data;
  let nonBlack = 0;
  let maxLum = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const colorSet = new Set();
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] + d[i + 1] + d[i + 2];
    if (lum > 12) {
      nonBlack++;
      sumR += d[i];
      sumG += d[i + 1];
      sumB += d[i + 2];
      colorSet.add(`${d[i] >> 4}_${d[i + 1] >> 4}_${d[i + 2] >> 4}`);
    }
    if (lum > maxLum) maxLum = lum;
  }
  const n = Math.max(1, nonBlack);
  return {
    nonBlackPixels: nonBlack,
    sampled: (d.length / 4) | 0,
    maxLum,
    avgColor: [
      Math.round(sumR / n),
      Math.round(sumG / n),
      Math.round(sumB / n),
    ],
    distinctColors: colorSet.size,
  };
}

/** `probe-voxel-megatexture.mjs` PART 2 `px2`. */
function legacyStreamingPx(img) {
  const rx = Math.floor(img.width * 0.3);
  const ry = Math.floor(img.height * 0.3);
  const d = getImageData(
    img,
    rx,
    ry,
    Math.floor(img.width * 0.4),
    Math.floor(img.height * 0.4),
  ).data;
  let nonBlack = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] + d[i + 1] + d[i + 2] > 12) nonBlack++;
  }
  return { nonBlackPixels: nonBlack };
}

/** `probe-voxel-megatexture.mjs` PART 3 `diffA`. */
function legacyCornerDiff(a, b) {
  const grab = (img) =>
    getImageData(
      img,
      Math.floor(a.width * 0.2),
      Math.floor(a.height * 0.2),
      Math.floor(a.width * 0.6),
      Math.floor(a.height * 0.6),
    ).data;
  const da = grab(a);
  const db = grab(b);
  let mismatch = 0;
  let nonBlackA = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i] + da[i + 1] + da[i + 2] > 12) nonBlackA++;
    if (
      Math.abs(da[i] - db[i]) > 8 ||
      Math.abs(da[i + 1] - db[i + 1]) > 8 ||
      Math.abs(da[i + 2] - db[i + 2]) > 8
    ) {
      mismatch++;
    }
  }
  const total = (da.length / 4) | 0;
  return { total, nonBlackA, mismatch, mismatchPct: (100 * mismatch) / total };
}

/** The octree probes' far-view centre crop and its mean absolute difference. */
function legacyCrop(img) {
  const rx = Math.floor(img.width * 0.3);
  const ry = Math.floor(img.height * 0.3);
  const rw = Math.floor(img.width * 0.4);
  const rh = Math.floor(img.height * 0.4);
  const d = getImageData(img, rx, ry, rw, rh).data;
  const px = [];
  for (let i = 0; i < d.length; i += 4) {
    px.push(d[i], d[i + 1], d[i + 2]);
  }
  return px;
}
function legacyFarDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / Math.max(1, n);
}

// ---------------------------------------------------------------------------
// Hand-derived cases
// ---------------------------------------------------------------------------

test("fractionalRegion floors the origin and the extent separately", () => {
  // 1024 * 0.2 = 204.8 -> 204; 768 * 0.2 = 153.6 -> 153;
  // 1024 * 0.55 = 563.2 -> 563; 768 * 0.6 = 460.8 -> 460.
  assert.deepEqual(
    fractionalRegion({ width: 1024, height: 768 }, VOXEL_PARITY_REGION),
    { x0: 204, y0: 153, x1: 767, y1: 613 },
  );
  // Flooring the far edge instead (floor(1024 * 0.75) = 768) would differ.
  assert.throws(() =>
    fractionalRegion({ width: 4, height: 4 }, { x: 0, y: 0, w: NaN, h: 1 }),
  );
});

test("regionColourStats counts strictly above the threshold and rounds the mean", () => {
  const image = frame(4, 2);
  put(image, 0, 0, [7, 7, 6]); // r+g+b = 20: NOT above 20
  put(image, 1, 0, [7, 7, 7]); // 21: counted
  put(image, 2, 0, [100, 50, 0]); // 150: counted
  put(image, 3, 1, [1, 2, 3]); // 6: black, but its lum still feeds maxLum below
  const stats = regionColourStats(
    image,
    { x0: 0, y0: 0, x1: 4, y1: 2 },
    { lumThreshold: 20, quantizeShift: 5 },
  );
  assert.equal(stats.sampled, 8); // 4 x 2
  assert.equal(stats.nonBlack, 2); // (1,0) and (2,0)
  assert.equal(stats.coveragePct, 25); // 2 / 8
  // mean of (7,7,7) and (100,50,0) = (53.5, 28.5, 3.5) -> Math.round -> (54, 29, 4)
  assert.deepEqual(stats.avgColor, [54, 29, 4]);
  // >> 5: (0,0,0) and (3,1,0) are two classes
  assert.equal(stats.distinctColours, 2);
  assert.equal(stats.maxLum, 150);

  const empty = regionColourStats(image, { x0: 3, y0: 0, x1: 4, y1: 1 });
  assert.deepEqual(empty.avgColor, [0, 0, 0]); // divisor floored at 1
  assert.equal(empty.nonBlack, 0);
});

test("footprintGrid samples floor((g / grid) * extent) and keeps each marked colour", () => {
  // Region 8 x 4 with a 4 x 2 grid: sx = floor(gx / 4 * 8) = 2 gx, sy = 2 gy.
  const image = frame(8, 4);
  put(image, 2, 0, [30, 0, 0]); // grid (1,0): marked
  put(image, 6, 2, [0, 0, 21]); // grid (3,1): marked
  put(image, 3, 0, [255, 255, 255]); // odd x: never sampled
  const grid = footprintGrid(
    image,
    { x0: 0, y0: 0, x1: 8, y1: 4 },
    { gridWidth: 4, gridHeight: 2 },
  );
  assert.deepEqual(Array.from(grid.mask), [0, 1, 0, 0, 0, 0, 0, 1]);
  assert.equal(grid.maskCells, 2);
  assert.deepEqual(grid.cellRgb[1], [30, 0, 0]);
  assert.deepEqual(grid.cellRgb[7], [0, 0, 21]);
  assert.equal(grid.cellRgb[0], null);
  // >> 5: (0,0,0) for both (30>>5 = 0, 21>>5 = 0) -> one class
  assert.equal(grid.colourClasses, 1);
});

test("maskIoU is intersection over union, and 0 for an empty union", () => {
  // a = {1,2}, b = {2,3}: intersection {2}, union {1,2,3}
  assert.deepEqual(maskIoU([0, 1, 1, 0], [0, 0, 1, 1]), {
    intersection: 1,
    union: 3,
    iou: 1 / 3,
  });
  assert.deepEqual(maskIoU([0, 0], [0, 0]), {
    intersection: 0,
    union: 0,
    iou: 0,
  });
  assert.throws(() => maskIoU([1], [1, 0]));
});

test("colourL1, and the kit's spread the parity probes read as channel spread", () => {
  assert.equal(colourL1([10, 20, 30], [13, 16, 30]), 7); // 3 + 4 + 0
  // `lib/determinism-kit.mjs` `spread` (largest - smallest) over an average
  // colour is the parity and custom-shader probes' WebGPU channel spread.
  assert.equal(spread([120, 118, 125]), 7); // 125 - 118
  assert.equal(spread([90, 90, 90]), 0);
});

test("interiorCellColourMatch counts only cells whose four neighbours are marked in both grids", () => {
  // A 4 x 4 grid fully marked in both: interior = the 2 x 2 centre (indices 5,6,9,10).
  const shape = { gridWidth: 4, gridHeight: 4 };
  const full = new Uint8Array(16).fill(1);
  const ref = { ...shape, mask: full, cellRgb: new Array(16).fill(null) };
  const cand = { ...shape, mask: full, cellRgb: new Array(16).fill(null) };
  for (let i = 0; i < 16; i++) {
    ref.cellRgb[i] = [0, 0, 0];
    cand.cellRgb[i] = [0, 0, 0];
  }
  ref.cellRgb[5] = [100, 0, 0];
  ref.cellRgb[6] = [0, 100, 0];
  ref.cellRgb[9] = [0, 0, 0];
  ref.cellRgb[10] = [0, 0, 0];
  cand.cellRgb[5] = [100, 0, 0]; // distance 0
  cand.cellRgb[6] = [0, 40, 0]; // distance 60: NOT below 60
  cand.cellRgb[9] = [59, 0, 0]; // distance 59: matches
  cand.cellRgb[10] = [0, 0, 0]; // distance 0
  const result = interiorCellColourMatch(ref, cand);
  assert.equal(result.interiorCells, 4);
  assert.equal(result.matchedCells, 3);
  assert.equal(result.matchFraction, 0.75);
  assert.equal(result.meanDistance, (0 + 60 + 59 + 0) / 4);
  // reds (100,0,0,0): mean 25, variance (5625+625*3)/4 = 1875 -> sqrt 43.30...
  // greens (0,100,0,0): the same spread; sum = 2 * sqrt(1875)
  assert.ok(Math.abs(result.referenceSpread - 2 * Math.sqrt(1875)) < 1e-12);

  // Unmark the cell above cell 5 in the candidate only: cell 5 stops being
  // interior (its neighbours 1, 4, 6, 9 are no longer all marked in both),
  // and cells 6, 9 and 10, which do not neighbour cell 1, stay interior.
  const holed = { ...cand, mask: Uint8Array.from(full) };
  holed.mask[1] = 0;
  assert.equal(interiorCellColourMatch(ref, holed).interiorCells, 3);

  const none = interiorCellColourMatch(
    { ...shape, mask: new Uint8Array(16), cellRgb: ref.cellRgb },
    cand,
  );
  assert.equal(none.meanDistance, 999);
  assert.equal(none.matchFraction, 0);
});

test("framePairRegionDifference counts channel moves above the tolerance inside the region only", () => {
  // 10 x 10, region {0.2,0.2,0.6,0.6} -> x0 = y0 = 2, extent 6 -> [2,8) x [2,8): 36 px.
  const a = frame(10, 10);
  const b = frame(10, 10);
  put(a, 2, 2, [100, 100, 100]);
  put(b, 2, 2, [108, 100, 100]); // |dr| = 8: not above 8
  put(a, 3, 2, [100, 100, 100]);
  put(b, 3, 2, [100, 91, 100]); // |dg| = 9: counted
  put(b, 0, 0, [255, 255, 255]); // outside the region: ignored
  put(a, 4, 4, [5, 5, 5]); // r+g+b 15: lit at the default 12 (not at 20)
  put(b, 4, 4, [5, 5, 5]); // unchanged: not a mismatch
  const result = framePairRegionDifference(a, b, {
    x: 0.2,
    y: 0.2,
    w: 0.6,
    h: 0.6,
  });
  assert.equal(result.comparable, true);
  assert.equal(result.total, 36);
  assert.equal(result.mismatch, 1);
  assert.equal(result.mismatchPct, 100 / 36);
  assert.equal(result.nonBlackA, 3); // three lit pixels of a inside the region

  const smaller = framePairRegionDifference(a, frame(9, 10), {
    x: 0.2,
    y: 0.2,
    w: 0.6,
    h: 0.6,
  });
  // Not comparable: NaN counts, so a caller's `mismatchPct < bar` FAILS
  // (`null < 1.5` is true in JavaScript and would pass it).
  assert.equal(smaller.comparable, false);
  assert.ok(Number.isNaN(smaller.mismatch));
  assert.ok(Number.isNaN(smaller.mismatchPct));
  assert.equal(smaller.mismatchPct < 1.5, false);
  assert.equal(smaller.nonBlackA, 3); // still a's own count
});

test("cropMeanAbsDifference averages absolute channel deltas over the crop", () => {
  // 10 x 10, crop {0.3,0.3,0.4,0.4} -> [3,7) x [3,7): 16 px, 48 values.
  const a = frame(10, 10);
  const b = frame(10, 10);
  put(b, 3, 3, [48, 0, 0]); // one value off by 48 -> mean 48 / 48 = 1
  assert.equal(cropMeanAbsDifference(a, b), 1);
  put(b, 9, 9, [255, 255, 255]); // outside the crop
  assert.equal(cropMeanAbsDifference(a, b), 1);
  assert.equal(
    regionRgbValues(a, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }).length,
    48,
  );
});

test("cropMeanAbsDifference fails closed: frames of different sizes, or an empty crop, answer NaN", () => {
  // 256 x 192, crop {0.3,0.3,0.4,0.4} -> [76,178) x [57,133); lit white in
  // its lower rows y 100..132 only.
  const lit = frame(256, 192);
  for (let y = 100; y < 133; y++) {
    for (let x = 76; x < 178; x++) {
      put(lit, x, y, [255, 255, 255]);
    }
  }
  // Control, same sizes: a real number, far above the octree probes' bar.
  const control = cropMeanAbsDifference(frame(256, 192), lit);
  assert.ok(control > 6, `control read ${control}`);

  // A smaller black frame: 100 x 75 crops to 40 x 30 = 1,200 px, 3,600
  // values, which cover only the big crop's first 1,200 px (its rows 57..68,
  // all black). The retired arithmetic scored those misaligned lists and
  // read 0, a pass; the extraction refuses to score them.
  const small = frame(100, 75);
  assert.equal(legacyFarDiff(legacyCrop(small), legacyCrop(lit)), 0);
  const mismatched = cropMeanAbsDifference(small, lit);
  assert.ok(Number.isNaN(mismatched));
  assert.equal(mismatched < 6, false);
  assert.ok(Number.isNaN(cropMeanAbsDifference(lit, small)));
  assert.ok(Number.isNaN(cropMeanAbsDifference(frame(256, 191), lit)));

  // Width alone (S1): a 250 x 192 black frame against a 256 x 192 frame lit
  // only in its crop's last row (y 132). The heights agree, so only the width
  // leg of the size check can refuse the pair; a height-only check would
  // score the smaller crop's 7,600 px against the first 7,600 of the bigger
  // one (its rows 57..131, all black) and read 0, a pass.
  const lastRow = frame(256, 192);
  for (let x = 76; x < 178; x++) {
    put(lastRow, x, 132, [255, 255, 255]);
  }
  const narrow = frame(250, 192);
  assert.equal(legacyFarDiff(legacyCrop(narrow), legacyCrop(lastRow)), 0);
  const widthOnly = cropMeanAbsDifference(narrow, lastRow);
  assert.ok(Number.isNaN(widthOnly));
  assert.equal(widthOnly < 6, false);

  // A 2 x 2 frame crops to 0 x 0 (floor(2 * 0.4) = 0). Against a full frame
  // it is a size mismatch; against another 2 x 2 frame the crop is empty.
  // The retired page threw on the zero extent rather than passing.
  const twoByTwo = frame(2, 2);
  put(twoByTwo, 0, 0, [255, 255, 255]);
  assert.ok(Number.isNaN(cropMeanAbsDifference(frame(256, 192), twoByTwo)));
  const empty = cropMeanAbsDifference(frame(2, 2), twoByTwo);
  assert.ok(Number.isNaN(empty));
  assert.equal(empty < 6, false);
  assert.throws(() => legacyCrop(twoByTwo), { name: "IndexSizeError" });
});

// ---------------------------------------------------------------------------
// Differential cases: the extraction reproduces the retired arithmetic
// ---------------------------------------------------------------------------

test("DIFFERENTIAL: the parity-family footprint and colour statistics equal the retired in-page px", () => {
  for (const seed of [1, 7, 20260926]) {
    const img = seededFrame(1024, 768, seed);
    const legacy = legacyParityPx(img);
    const region = fractionalRegion(img, VOXEL_PARITY_REGION);
    const grid = footprintGrid(img, region);
    const stats = regionColourStats(img, region, { lumThreshold: 20 });
    assert.deepEqual(Array.from(grid.mask), legacy.mask);
    assert.deepEqual(grid.cellRgb, legacy.cellRGB);
    assert.equal(grid.maskCells, legacy.maskCells);
    assert.equal(grid.colourClasses, legacy.distinctColors);
    assert.deepEqual(stats.avgColor, legacy.avgColor);
    assert.equal(stats.coveragePct, legacy.coveragePct);
  }
});

test("DIFFERENTIAL: IoU and the interior per-cell match equal the retired ellipsoid arithmetic", () => {
  const imgA = seededFrame(1024, 768, 11);
  const imgB = seededFrame(1024, 768, 12);
  const la = legacyParityPx(imgA);
  const lb = legacyParityPx(imgB);
  const ga = footprintGrid(imgA, fractionalRegion(imgA, VOXEL_PARITY_REGION));
  const gb = footprintGrid(imgB, fractionalRegion(imgB, VOXEL_PARITY_REGION));
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < la.mask.length; i++) {
    if (la.mask[i] && lb.mask[i]) inter++;
    if (la.mask[i] || lb.mask[i]) uni++;
  }
  assert.equal(maskIoU(ga.mask, gb.mask).iou, uni > 0 ? inter / uni : 0);
  const legacy = legacyInteriorMatch(la.mask, lb.mask, la.cellRGB, lb.cellRGB);
  const extracted = interiorCellColourMatch(ga, gb);
  assert.equal(extracted.interiorCells, legacy.interiorCells);
  assert.equal(extracted.matchedCells, legacy.matchedCells);
  assert.equal(extracted.matchFraction, legacy.matchFrac);
  assert.equal(extracted.meanDistance, legacy.meanDist);
  assert.equal(extracted.referenceSpread, legacy.glSpread);
  assert.ok(legacy.interiorCells > 0, "the fixture exercised no interior cell");
});

test("DIFFERENTIAL: the megatexture PART 1 / PART 2 statistics and the PART 3 corner diff equal the retired code", () => {
  const img = seededFrame(1024, 768, 3);
  const legacy1 = legacyMegatexturePx(img);
  const stats1 = regionColourStats(
    img,
    fractionalRegion(img, { x: 0.28, y: 0.28, w: 0.4, h: 0.4 }),
    { lumThreshold: 12, quantizeShift: 4 },
  );
  assert.equal(stats1.nonBlack, legacy1.nonBlackPixels);
  assert.equal(stats1.sampled, legacy1.sampled);
  assert.equal(stats1.maxLum, legacy1.maxLum);
  assert.deepEqual(stats1.avgColor, legacy1.avgColor);
  assert.equal(stats1.distinctColours, legacy1.distinctColors);

  const stats2 = regionColourStats(
    img,
    fractionalRegion(img, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }),
    { lumThreshold: 12 },
  );
  assert.equal(stats2.nonBlack, legacyStreamingPx(img).nonBlackPixels);

  const other = seededFrame(1024, 768, 4);
  // Half the frame identical, so the count is neither 0 nor everything.
  other.data.set(img.data.subarray(0, img.data.length / 2));
  const legacy3 = legacyCornerDiff(img, other);
  const extracted3 = framePairRegionDifference(img, other, {
    x: 0.2,
    y: 0.2,
    w: 0.6,
    h: 0.6,
  });
  assert.equal(extracted3.total, legacy3.total);
  assert.equal(extracted3.nonBlackA, legacy3.nonBlackA);
  assert.equal(extracted3.mismatch, legacy3.mismatch);
  assert.equal(extracted3.mismatchPct, legacy3.mismatchPct);
  assert.ok(legacy3.mismatch > 0 && legacy3.mismatch < legacy3.total);

  // The empty-region edge (a 1 x 1 frame crops to 0 x 0): the retired code
  // never measured it, because the page's `getImageData` throws on a zero
  // extent, so the old probe crashed; the extraction answers NaN, which fails
  // the caller's bar. Neither passes.
  const tiny = frame(1, 1);
  assert.throws(() => legacyCornerDiff(tiny, tiny), { name: "IndexSizeError" });
  const extractedEmpty = framePairRegionDifference(tiny, tiny, {
    x: 0.2,
    y: 0.2,
    w: 0.6,
    h: 0.6,
  });
  assert.equal(extractedEmpty.total, 0);
  assert.ok(Number.isNaN(extractedEmpty.mismatchPct));
  assert.equal(extractedEmpty.mismatchPct < 1.5, false);
});

test("DIFFERENTIAL: the octree far-view crop difference equals the retired code", () => {
  const a = seededFrame(1024, 768, 5);
  const b = seededFrame(1024, 768, 6);
  assert.equal(
    cropMeanAbsDifference(a, b),
    legacyFarDiff(legacyCrop(a), legacyCrop(b)),
  );
});
