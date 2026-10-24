// @purpose Pins the global coastline water classification provider: tile masks, island and open-ocean fast paths, tile-seam agreement of the generate and augment paths (and a tile's border texels equal to the same texels inside an overlapping tile, which pins the distance-field pad), and the byte-bounded tile cache.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const { GlobalCoastlineWaterClassificationProvider } =
  await import("../../packages/engine/Source/Scene/GlobalCoastlineWaterClassificationProvider.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSET_PATH = path.resolve(
  here,
  "../../packages/engine/Source/Assets/WaterMask/ne50mCoastlines.bin",
);
const RAD = Math.PI / 180.0;

// Compares typed arrays without letting assert print a megabyte diff on failure.
function assertSameBytes(actual, expected, message = "bytes differ") {
  assert.equal(actual.length, expected.length, message + " (length)");
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      assert.fail(
        `${message}: first difference at ${i} (${actual[i]} !== ${expected[i]})`,
      );
    }
  }
}

test("1. GlobalCoastlineWaterClassificationProvider loads LWM1 binary and parses polygons", () => {
  const buf = fs.readFileSync(ASSET_PATH);
  const provider = new GlobalCoastlineWaterClassificationProvider(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  assert.equal(provider.ready, true);
});

test("2. Open ocean tile fast path produces 1-byte all-water mask [255]", () => {
  const buf = fs.readFileSync(ASSET_PATH);
  const provider = new GlobalCoastlineWaterClassificationProvider(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );

  // Mid-Pacific tile: lon -140..-138, lat 0..2
  const rect = {
    west: -140.0 * RAD,
    south: 0.0 * RAD,
    east: -138.0 * RAD,
    north: 2.0 * RAD,
  };

  const mask = provider.generateWaterMask(rect, 256);
  assert.equal(mask.length, 1);
  assert.equal(mask[0], 255);
});

test("3. Deep continental interior tile produces 1-byte all-land mask [0]", () => {
  const buf = fs.readFileSync(ASSET_PATH);
  const provider = new GlobalCoastlineWaterClassificationProvider(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );

  // Deep inland Kansas: lon -99.0..-98.0, lat 38.0..39.0
  const rect = {
    west: -99.0 * RAD,
    south: 38.0 * RAD,
    east: -98.0 * RAD,
    north: 39.0 * RAD,
  };

  const mask = provider.generateWaterMask(rect, 256);
  assert.equal(mask.length, 1);
  assert.equal(mask[0], 0);
});

test("4. Coastal Kauai tile produces 256x256 mask with both land and ocean pixels", (t) => {
  const buf = fs.readFileSync(ASSET_PATH);
  const provider = new GlobalCoastlineWaterClassificationProvider(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );

  // Kauai island bounds: lon -159.8..-159.2, lat 21.8..22.3
  const rect = {
    west: -159.8 * RAD,
    south: 21.8 * RAD,
    east: -159.2 * RAD,
    north: 22.3 * RAD,
  };

  assert.equal(provider.intersectsRectangle(rect), true);

  const start = performance.now();
  const mask = provider.generateWaterMask(rect, 256);
  const elapsed = performance.now() - start;

  assert.equal(mask.length, 256 * 256);
  let landCount = 0;
  let waterCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) landCount++;
    else if (mask[i] === 255) waterCount++;
  }

  assert.ok(landCount > 0, "Must have land pixels on island");
  assert.ok(waterCount > 0, "Must have ocean pixels around island");
  // The first call is cold: nothing is warmed at import any more (DE-07), so
  // it pays JIT and scratch allocation. Timings are reported, not asserted: a
  // wall-clock ceiling here went red under machine load at the water landing
  // freeze (70 ms against 50), and the water specs carry no wall-clock bound
  // (IT-04); the relative cost bounds live in water-multi-biome-perf-compile.
  const steadyStart = performance.now();
  const steadyMask = provider.generateWaterMask(
    { ...rect, west: rect.west + 1e-4, east: rect.east + 1e-4 },
    256,
  );
  const steady = performance.now() - steadyStart;
  assert.equal(steadyMask.length, 256 * 256);
  t.diagnostic(
    `Kauai 256x256 rasterization: cold ${elapsed.toFixed(2)} ms, steady ${steady.toFixed(2)} ms`,
  );
});

test("5. Bahamas shallow reef coastal tile produces valid 256x256 island mask", () => {
  const buf = fs.readFileSync(ASSET_PATH);
  const provider = new GlobalCoastlineWaterClassificationProvider(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );

  // Bahamas New Providence / Andros: lon -78.0..-77.0, lat 24.5..25.5
  const rect = {
    west: -78.0 * RAD,
    south: 24.5 * RAD,
    east: -77.0 * RAD,
    north: 25.5 * RAD,
  };

  const mask = provider.generateWaterMask(rect, 256);
  assert.equal(mask.length, 256 * 256);
  let landCount = 0;
  let waterCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) landCount++;
    else if (mask[i] === 255) waterCount++;
  }
  assert.ok(landCount > 0, "Bahamas tile must have island land pixels");
  assert.ok(waterCount > 0, "Bahamas tile must have surrounding sea pixels");
});

function maxBorderDiff(west, east) {
  let max = 0;
  for (let r = 0; r < 256; r++) {
    max = Math.max(max, Math.abs(west[r * 256 + 255] - east[r * 256]));
  }
  return max;
}

test("6. DE-05 adjacent augmented Miami tiles agree across their shared border as well as generated ones", () => {
  const buf = fs.readFileSync(ASSET_PATH);
  const provider = new GlobalCoastlineWaterClassificationProvider(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  const tile = (west, east) => ({
    west: west * RAD,
    east: east * RAD,
    south: 25.7 * RAD,
    north: 25.8 * RAD,
  });
  const a = tile(-80.23, -80.13);
  const b = tile(-80.13, -80.03);

  const generatedA = provider.generateWaterMask(a, 256);
  const generatedB = provider.generateWaterMask(b, 256);
  assert.equal(generatedA.length, 256 * 256);
  const generatedSeam = maxBorderDiff(generatedA, generatedB);
  assert.ok(generatedSeam > 0, "the tiles must actually cross the coast");

  // A terrain provider that says "all water" must be refined by the coast to
  // exactly what the generate path produces, seam included.
  const allWater = () => new Uint8Array(256 * 256).fill(255);
  const augmentedA = provider.augmentWaterMask(allWater(), a, 256);
  const augmentedB = provider.augmentWaterMask(allWater(), b, 256);
  assert.ok(augmentedA && augmentedB);
  assert.ok(
    maxBorderDiff(augmentedA, augmentedB) <= generatedSeam,
    `augmented seam ${maxBorderDiff(augmentedA, augmentedB)} exceeds generated seam ${generatedSeam}`,
  );
  assertSameBytes(augmentedA, generatedA);
  assertSameBytes(augmentedB, generatedB);

  // The caller's mask is left alone.
  const input = allWater();
  provider.augmentWaterMask(input, a, 256);
  assert.ok(input.every((v) => v === 255));
});

test("6b. N3 a shore just outside a tile's border: the border texels equal the same texels inside an overlapping tile (the pad covers the field radius and the smoothing)", () => {
  // Water round 6 (review pass 5, N3). Each tile's distance field is built over
  // a padded mask so its border texels see the neighbourhood an unbounded field
  // would; the round-5 shore smoothing reads two texels further, so the pad grew
  // by that radius. A 0.2-degree tile has 87 m texels, where the field radius
  // clamps to 8 texels; at offsets 9 and 41 of this scan (texels of 0.2 / 256
  // degrees) the Miami shore lies about 10 texels east of the tile's east
  // border, inside the reach of a border texel's smoothing neighbours. The
  // tile's last 20 columns must equal the same texels inside the tile shifted
  // 32 texels east, exactly. Without the smoothing radius in the pad
  // (`ceil(r) + 1`) they differ by 1 at both offsets (measured).
  const buf = fs.readFileSync(ASSET_PATH);
  const W = -80.37;
  const E = -80.17;
  const S = 25.7;
  const N = 25.9;
  const dx = (E - W) / 256;
  const shift = 32;
  let compared = 0;
  for (const k of [9, 41]) {
    const provider = new GlobalCoastlineWaterClassificationProvider(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
    const rect = (sx) => ({
      west: (W + k * dx + sx) * RAD,
      east: (E + k * dx + sx) * RAD,
      south: S * RAD,
      north: N * RAD,
    });
    const tile = provider.generateWaterMask(rect(0), 256);
    const overlap = provider.generateWaterMask(rect(shift * dx), 256);
    assert.equal(tile.length, 256 * 256, `offset ${k}: a coastal tile`);
    assert.equal(overlap.length, 256 * 256, `offset ${k}: a coastal tile`);
    let band = 0;
    for (let r = 0; r < 256; r++) {
      for (let c = 236; c < 256; c++) {
        const a = tile[r * 256 + c];
        const b = overlap[r * 256 + c - shift];
        if (a > 0 && a < 255) {
          band += 1;
        }
        if (a !== b) {
          assert.fail(
            `offset ${k}: border texel (${c}, ${r}) is ${a}, inside the overlapping tile ${b}`,
          );
        }
        compared += 1;
      }
    }
    assert.ok(
      band > 0,
      `offset ${k}: the shore's band reaches the border columns`,
    );
  }
  assert.equal(compared, 2 * 256 * 20);
});

test("7. DE-12 the tile cache is bounded by bytes, not just by entry count", () => {
  const buf = fs.readFileSync(ASSET_PATH);
  const provider = new GlobalCoastlineWaterClassificationProvider(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  // 600 distinct coastal 256x256 masks (64 KiB each = 37.5 MiB) over Kauai.
  for (let i = 0; i < 600; i++) {
    const shift = i * 1e-5;
    provider.generateWaterMask(
      {
        west: -159.8 * RAD + shift,
        south: 21.8 * RAD,
        east: -159.2 * RAD + shift,
        north: 22.3 * RAD,
      },
      256,
    );
  }
  assert.ok(provider.cachedTileBytes <= 32 * 1024 * 1024);
  assert.ok(provider.cachedTileCount < 600, "old tiles must be evicted");
  assert.ok(provider.cachedTileCount > 100);
});

// ───── water round 5, FND-1: the shore follows the coast, not the raster ─────
//
// The distance field is built from texel-centre classification, so before the
// smoothing its 0.5 isoline followed the raster's staircase: at the Great Lakes
// camera (about three screen pixels per texel of a 128-texel tile) both
// renderers drew a serrated shore. These cases measure the isoline itself.

const { applyCoastalSignedDistanceField, COASTAL_SDF_SMOOTHING_RADIUS_TEXELS } =
  await import("../../packages/engine/Source/Scene/GlobalCoastlineWaterClassificationProvider.js");

/**
 * A size x size binary mask (255 water, 0 land) of the half-plane
 * `x > x0 + slope * y` sampled at texel centres, turned into the shipped
 * distance field, and the 0.5 isoline's sub-texel crossing per row (linear
 * between the two texel centres that straddle 127.5), against the true line.
 */
function halfPlaneIsoline(slope, x0, size = 96, radius = 6) {
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      mask[y * size + x] = x + 0.5 > x0 + slope * (y + 0.5) ? 255 : 0;
    }
  }
  applyCoastalSignedDistanceField(mask, size, radius);
  const deviations = [];
  for (let y = 16; y < size - 16; y++) {
    // Only rows whose shore lies well inside the mask.
    const truth = x0 + slope * (y + 0.5);
    if (truth < 12 || truth > size - 12) {
      continue;
    }
    const row = y * size;
    for (let x = 0; x < size - 1; x++) {
      const a = mask[row + x];
      const b = mask[row + x + 1];
      if (a < 127.5 && b >= 127.5) {
        const crossing = x + 0.5 + (127.5 - a) / (b - a);
        deviations.push(crossing - (x0 + slope * (y + 0.5)));
        break;
      }
    }
  }
  const mean = deviations.reduce((s, d) => s + d, 0) / deviations.length;
  const spread = Math.max(...deviations.map((d) => Math.abs(d - mean)));
  return { mask, mean, spread, rows: deviations.length };
}

test("8. FND-1 a straight shore at a shallow angle crosses 0.5 on the true line, without the texel staircase", () => {
  assert.equal(COASTAL_SDF_SMOOTHING_RADIUS_TEXELS, 2);
  // The staircase of the unsmoothed field swings the isoline by about half a
  // texel either side of the line (measured 0.498 at slope 0.37 and 0.483 at
  // 0.12, the long runs of a shallow shore); the smoothing brings that to 0.192
  // and 0.287, and does not shift the line (offset 0.002).
  for (const [slope, bound] of [
    [0.37, 0.25],
    [0.12, 0.35],
  ]) {
    const { mean, spread, rows } = halfPlaneIsoline(slope, 30.3);
    assert.ok(rows > 50, `rows measured: ${rows}`);
    assert.ok(
      spread < bound,
      `slope ${slope}: isoline swing ${spread.toFixed(3)} texel`,
    );
    assert.ok(
      Math.abs(mean) < 0.1,
      `slope ${slope}: isoline offset ${mean.toFixed(3)} texel`,
    );
  }
});

test("8b. FND-1 the smoothing keeps the field's contract: land and water beyond the band exact, the band in [1, 254]", () => {
  const radius = 6;
  const { mask } = halfPlaneIsoline(0.37, 30.3, 96, radius);
  const reach = radius + 0.5 + COASTAL_SDF_SMOOTHING_RADIUS_TEXELS + 1.5;
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 96; x++) {
      const v = mask[y * 96 + x];
      // Horizontal distance overstates the true one by 1/cos, so this is safe.
      const d = (x + 0.5 - (30.3 + 0.37 * (y + 0.5))) / Math.hypot(1, 0.37);
      if (d > reach) {
        assert.equal(v, 255, `water at (${x}, ${y})`);
      } else if (d < -reach) {
        assert.equal(v, 0, `land at (${x}, ${y})`);
      }
      if (Math.abs(d) < 1) {
        assert.ok(v >= 1 && v <= 254, `band texel (${x}, ${y}) = ${v}`);
      }
    }
  }
});
