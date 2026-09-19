// metrics-structure.spec.mjs — behaviour spec for
// `lib/metrics/connected-components.mjs` and `lib/metrics/structure-similarity.mjs`.
// @purpose Behaviour spec proving connected-component and SSIM metrics see structure a band mean cannot, over hand-derived fixtures.
// @status ACTIVE
//
// EVERY EXPECTED NUMBER BELOW IS A LITERAL WITH A ONE-LINE DERIVATION COMMENT,
// never a call back into the module under test — that is what "hand-derivable"
// means for this spec (KIT-A-RULES.md). The SSIM literals in tests 4 and 5 are
// closed-form values of the Wang et al. formula for flat or two-region fields,
// computed independently of `structureSimilarity` (see each comment); they are
// not read back from the function being asserted on.

import assert from "node:assert/strict";
import test from "node:test";

import { connectedComponents } from "./lib/metrics/connected-components.mjs";
import {
  structureSimilarity,
  structureSimilarityRgba,
} from "./lib/metrics/structure-similarity.mjs";

/** Build a flat scalar field of `width*height` pixels, all zero. */
function zeros(width, height) {
  return { width, height, data: new Float64Array(width * height) };
}

/** Fill a rectangular block [x0,x1] x [y0,y1] (inclusive) with `value`. */
function fillBlock(field, x0, y0, x1, y1, value) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      field.data[y * field.width + x] = value;
    }
  }
  return field;
}

// ---------------------------------------------------------------------------
// Test 1: known component count, areas, bboxes, centroids.
// ---------------------------------------------------------------------------
test("connectedComponents: three 3x3 blocks + one 1px speck, count and geometry are literal", () => {
  // 7x7 field. Block A rows0-2/cols0-2, block B rows0-2/cols4-6, block C
  // rows4-6/cols0-2, speck at (6,6). Every pair is separated by at least one
  // background row/column, so all four are isolated at both connectivity 4
  // and 8. Raster scan (row-major) discovers A first, then B (same rows,
  // later columns), then C (later rows), then the speck last — so ids are
  // 1=A, 2=B, 3=C, 4=speck by construction.
  const field = zeros(7, 7);
  fillBlock(field, 0, 0, 2, 2, 1); // A
  fillBlock(field, 4, 0, 6, 2, 1); // B
  fillBlock(field, 0, 4, 2, 6, 1); // C
  field.data[6 * 7 + 6] = 1; // speck

  const atMinArea1 = connectedComponents(field, { threshold: 0, minArea: 1 });
  assert.equal(atMinArea1.count, 4);
  const [a, b, c, speck] = atMinArea1.components;
  // area 9 each for the 3x3 blocks (tie), sorted by id ascending among ties;
  // sumIntensity === area and meanIntensity === 1 because every foreground
  // pixel has value 1.
  assert.deepEqual(
    [a.id, a.area, a.bbox, a.centroid, a.sumIntensity, a.meanIntensity],
    [1, 9, { x0: 0, y0: 0, x1: 2, y1: 2 }, { x: 1, y: 1 }, 9, 1],
  );
  assert.deepEqual(
    [b.id, b.area, b.bbox, b.centroid, b.sumIntensity, b.meanIntensity],
    [2, 9, { x0: 4, y0: 0, x1: 6, y1: 2 }, { x: 5, y: 1 }, 9, 1],
  );
  assert.deepEqual(
    [c.id, c.area, c.bbox, c.centroid, c.sumIntensity, c.meanIntensity],
    [3, 9, { x0: 0, y0: 4, x1: 2, y1: 6 }, { x: 1, y: 5 }, 9, 1],
  );
  assert.deepEqual(
    [
      speck.id,
      speck.area,
      speck.bbox,
      speck.centroid,
      speck.sumIntensity,
      speck.meanIntensity,
    ],
    [4, 1, { x0: 6, y0: 6, x1: 6, y1: 6 }, { x: 6, y: 6 }, 1, 1],
  );

  // minArea 2 drops the 1-pixel speck (area 1 < 2); the surviving three keep
  // their original ids 1,2,3 because ids are assigned in raster discovery
  // order over ALL components, before the minArea filter is applied.
  const atMinArea2 = connectedComponents(field, { threshold: 0, minArea: 2 });
  assert.equal(atMinArea2.count, 3);
  assert.deepEqual(
    atMinArea2.components.map((comp) => comp.id),
    [1, 2, 3],
  );
});

// ---------------------------------------------------------------------------
// Test 2: connectivity changes the component count for a diagonal pair.
// ---------------------------------------------------------------------------
test("connectedComponents: a diagonal pair is 2 components at connectivity 4, 1 at connectivity 8", () => {
  // 2x2 field, foreground at (0,0) and (1,1) only — a pure diagonal pair.
  const field = zeros(2, 2);
  field.data[0] = 1; // (0,0)
  field.data[3] = 1; // (1,1)

  const c4 = connectedComponents(field, { threshold: 0, connectivity: 4 });
  assert.equal(c4.count, 2);
  assert.deepEqual(
    c4.components.map((comp) => [comp.id, comp.area, comp.bbox, comp.centroid]),
    [
      [1, 1, { x0: 0, y0: 0, x1: 0, y1: 0 }, { x: 0, y: 0 }],
      [2, 1, { x0: 1, y0: 1, x1: 1, y1: 1 }, { x: 1, y: 1 }],
    ],
  );

  const c8 = connectedComponents(field, { threshold: 0, connectivity: 8 });
  assert.equal(c8.count, 1);
  const [merged] = c8.components;
  // area 2 (both pixels merged); centroid is the mean of (0,0) and (1,1) =
  // (0.5, 0.5); sumIntensity 2, meanIntensity 1.
  assert.deepEqual(
    [
      merged.id,
      merged.area,
      merged.bbox,
      merged.centroid,
      merged.sumIntensity,
      merged.meanIntensity,
    ],
    [1, 2, { x0: 0, y0: 0, x1: 1, y1: 1 }, { x: 0.5, y: 0.5 }, 2, 1],
  );
});

// ---------------------------------------------------------------------------
// Test 3: THE LOAD-BEARING CASE. Equal band mean, unequal structure.
// ---------------------------------------------------------------------------
test("connectedComponents sees structure a band mean cannot: equal mean, unequal component count", () => {
  // Field A: one compact 4x4 block of value 25 (16 px x 25 = 400) inside a
  // 10x10 (100px) frame. Field B: the SAME total energy (16 x 25 = 400) as 16
  // isolated single-pixel specks at rows {0,2,4,6} x cols {0,2,4,6} — every
  // pair of chosen points is 2 apart in x or y, so none are 4- (or even 8-)
  // adjacent. Both fields are 10x10 with total intensity 400, so the band
  // mean (sum / 100) is 4.0 for both BY CONSTRUCTION — this is the case
  // C15-08 says a band mean cannot distinguish.
  const compact = fillBlock(zeros(10, 10), 0, 0, 3, 3, 25);
  const scattered = zeros(10, 10);
  for (const row of [0, 2, 4, 6]) {
    for (const col of [0, 2, 4, 6]) {
      scattered.data[row * 10 + col] = 25;
    }
  }

  const bandMean = (field) =>
    field.data.reduce((sum, v) => sum + v, 0) / field.data.length;

  // Both assertions in the SAME test: the blindness (equal band mean) and the
  // cure (unequal component count) are one demonstration, not two.
  assert.equal(bandMean(compact), 4);
  assert.equal(bandMean(scattered), 4);
  assert.equal(bandMean(compact), bandMean(scattered));

  const compactComponents = connectedComponents(compact, { threshold: 0 });
  const scatteredComponents = connectedComponents(scattered, { threshold: 0 });
  assert.equal(compactComponents.count, 1);
  assert.equal(scatteredComponents.count, 16);
  assert.notEqual(compactComponents.count, scatteredComponents.count);
});

// ---------------------------------------------------------------------------
// Test 4: SSIM against a copy is 1; against a shifted copy is in (0, 1).
// ---------------------------------------------------------------------------
test("structureSimilarity: identical field is 1, uniformly shifted field is a derived value in (0,1)", () => {
  // Flat 8x8 field (== default windowSize, so exactly ONE window) at value
  // 100, vs a flat field at 110 (every pixel +10).
  const flatA = { width: 8, height: 8, data: new Float64Array(64).fill(100) };
  const flatB = { width: 8, height: 8, data: new Float64Array(64).fill(110) };

  const self = structureSimilarity(flatA, flatA);
  assert.equal(self.windows, 1);
  assert.ok(Math.abs(self.mssim - 1) < 1e-12);

  // Derivation (Wang et al. formula, k1=0.01,k2=0.03,L=255 defaults):
  // c1=(0.01*255)^2=6.5025, c2=(0.03*255)^2=58.5225.
  // Flat fields: sigma_x^2=sigma_y^2=sigma_xy=0 (no variation in either).
  // mu_x=100, mu_y=110.
  // SSIM = (2*100*110+c1)*(0+c2) / ((100^2+110^2+c1)*(0+c2))
  //      = (22000+6.5025) / (10000+12100+6.5025)      [c2 cancels]
  //      = 22006.5025 / 22106.5025 = 0.9954764440915066
  const shifted = structureSimilarity(flatA, flatB);
  assert.equal(shifted.windows, 1);
  assert.ok(Math.abs(shifted.mssim - 0.9954764440915066) < 1e-9);
  assert.ok(shifted.mssim < 1);
  assert.ok(shifted.mssim > 0);
});

// ---------------------------------------------------------------------------
// Test 5: SSIM is sensitive to STRUCTURE, not to a constant offset of equal
// mean-absolute-difference.
// ---------------------------------------------------------------------------
test("structureSimilarity: equal mean-abs-diff, unequal mssim — scrambled scores lower than brightened", () => {
  // 8x8 checkerboard base: value 0 where (x+y) is even, 100 where odd — 32
  // cells of each (mean 50, population variance 2500, since every deviation
  // is +-50).
  const width = 8;
  const height = 8;
  const base = { width, height, data: new Float64Array(width * height) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      base.data[y * width + x] = (x + y) % 2 === 0 ? 0 : 100;
    }
  }

  // Brightened: +50 to every pixel (uniform offset). abs diff is 50 at every
  // one of the 64 pixels, so mean-abs-diff = 50.
  const brightened = { width, height, data: base.data.map((v) => v + 50) };

  // Scrambled: top half (rows 0-3) unchanged, bottom half (rows 4-7) inverted
  // (100 - value). Top half contributes abs diff 0 at 32 pixels; bottom half
  // contributes abs diff 100 at 32 pixels (0->100 or 100->0). Mean-abs-diff =
  // (0*32 + 100*32) / 64 = 50 — the SAME as brightened's — but the spatial
  // arrangement is a seam, not a shift.
  const scrambled = {
    width,
    height,
    data: base.data.map((v, i) => {
      const y = Math.floor(i / width);
      return y < 4 ? v : 100 - v;
    }),
  };

  const meanAbsDiff = (x, y) => {
    let sum = 0;
    for (let i = 0; i < x.data.length; i++) {
      sum += Math.abs(x.data[i] - y.data[i]);
    }
    return sum / x.data.length;
  };
  assert.equal(meanAbsDiff(base, brightened), 50);
  assert.equal(meanAbsDiff(base, scrambled), 50);

  const uniform = structureSimilarity(base, brightened);
  const scramble = structureSimilarity(base, scrambled);

  // Derivation (same c1/c2 as test 4). Both copies share base's mean(50) and
  // variance(2500) up to the transform:
  //  - brightened: mu_x=50,mu_y=100, sigma_x^2=sigma_y^2=2500,
  //    sigma_xy=Cov(X,X+50)=Var(X)=2500 (perfect linear correlation).
  //    SSIM = (2*50*100+c1)*(2*2500+c2) / ((50^2+100^2+c1)*(2500+2500+c2))
  //         = 0.8001039859065314
  //  - scrambled: mu_x=mu_y=50 (same multiset of values, just relabelled),
  //    sigma_x^2=sigma_y^2=2500, but sigma_xy = mean((base-50)(scrambled-50))
  //    = (32*2500 + 32*-2500)/64 = 0 (top half agrees fully, bottom half is
  //    exactly anti-correlated, and they cancel).
  //    SSIM = (2*50*50+c1)*(0+c2) / ((50^2+50^2+c1)*(0+c2))
  //         = 58.5225 / 5058.5225 = 0.011569089590883503
  assert.ok(Math.abs(uniform.mssim - 0.8001039859065314) < 1e-9);
  assert.ok(Math.abs(scramble.mssim - 0.011569089590883503) < 1e-9);
  assert.notEqual(uniform.mssim, scramble.mssim);
  assert.ok(scramble.mssim < uniform.mssim);
});

// ---------------------------------------------------------------------------
// Test 6: both modules throw on mismatched dimensions, naming both sizes.
// ---------------------------------------------------------------------------
test("connectedComponents and structureSimilarity throw on mismatched dimensions, naming both sizes", () => {
  assert.throws(
    () =>
      connectedComponents(
        { width: 3, height: 3, data: new Float64Array(10) },
        { threshold: 0 },
      ),
    /3x3.*got 10.*expected 9.*36/,
  );

  assert.throws(
    () =>
      structureSimilarity(
        { width: 4, height: 4, data: new Float64Array(16) },
        { width: 5, height: 5, data: new Float64Array(25) },
      ),
    /4x4.*5x5/,
  );
});

// ---------------------------------------------------------------------------
// structureSimilarityRgba agrees with connectedComponents on "intensity".
// ---------------------------------------------------------------------------
test("structureSimilarityRgba: identical RGBA fields score 1, via the same Rec.709 reduction connectedComponents uses", () => {
  const width = 8;
  const height = 8;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 120;
    rgba[i * 4 + 1] = 40;
    rgba[i * 4 + 2] = 10;
    rgba[i * 4 + 3] = 255;
  }
  const field = { width, height, data: rgba };
  const result = structureSimilarityRgba(field, field);
  assert.ok(Math.abs(result.mssim - 1) < 1e-12);

  assert.throws(
    () =>
      structureSimilarityRgba(
        { width: 2, height: 2, data: new Uint8ClampedArray(15) },
        { width: 2, height: 2, data: new Uint8ClampedArray(16) },
      ),
    /got 15.*expected 16/,
  );
});
