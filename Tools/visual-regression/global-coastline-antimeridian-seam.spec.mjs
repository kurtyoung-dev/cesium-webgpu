// global-coastline-antimeridian-seam.spec.mjs - the coastline water mask is continuous across +-180 deg.
// @purpose Pins that GlobalCoastlineWaterClassificationProvider sees coast polygons across the antimeridian when a tile's distance-field pad crosses it: land that continues across the seam keeps no fake shoreline, a coast crossing the seam has an ordinary tile seam, and the augment path matches the generate path there.
// @status ACTIVE
//
// The defect: a tile whose edge is +-180 deg pads its distance field past +-PI,
// but the polygons beyond the seam have longitudes on the other side, so the
// pad read as open water. Inside Chukotka every 0.2-degree tile on either side
// of the seam carried a 7-texel water fringe along the seam (1,792 texels), and
// across Fiji's seam tiles the border texels disagreed by up to 71 against 16
// between neighbouring texels inside each tile.
//
// Run: node --test Tools/visual-regression/global-coastline-antimeridian-seam.spec.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const { GlobalCoastlineWaterClassificationProvider } =
  await import("../../packages/engine/Source/Scene/GlobalCoastlineWaterClassificationProvider.js");
const { antimeridianWrapPasses } =
  await import("../../packages/engine/Source/Scene/GlobalCoastlineAntimeridian.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSET_PATH = path.resolve(
  here,
  "../../packages/engine/Source/Assets/WaterMask/ne50mCoastlines.bin",
);
const RAD = Math.PI / 180.0;
const SIZE = 256;
const SPAN = 0.2;

function loadProvider() {
  const buf = fs.readFileSync(ASSET_PATH);
  return new GlobalCoastlineWaterClassificationProvider(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}

// The pair of tiles meeting at the antimeridian at latitude `south`: `west`
// ends at +180 deg, `east` starts at -180 deg.
function seamPair(south) {
  return {
    west: {
      west: (180 - SPAN) * RAD,
      east: Math.PI,
      south: south * RAD,
      north: (south + SPAN) * RAD,
    },
    east: {
      west: -Math.PI,
      east: (-180 + SPAN) * RAD,
      south: south * RAD,
      north: (south + SPAN) * RAD,
    },
  };
}

const texel = (mask, r, c) =>
  mask.length === 1 ? mask[0] : mask[r * SIZE + c];

function waterTexels(mask) {
  let n = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (texel(mask, r, c) !== 0) {
        n++;
      }
    }
  }
  return n;
}

test("wrap passes: none inside [-PI, PI]; one per side the pad crosses, shifted a full turn", () => {
  const inside = { west: -1, south: 0.1, east: 1, north: 0.2 };
  assert.deepEqual(antimeridianWrapPasses(inside), []);

  const west = antimeridianWrapPasses({
    west: -Math.PI - 0.01,
    south: 0.1,
    east: -Math.PI + 0.05,
    north: 0.2,
  });
  assert.equal(west.length, 1);
  assert.ok(Math.abs(west[0].queryRect.west - (Math.PI - 0.01)) < 1e-12);
  assert.equal(west[0].queryRect.east, Math.PI);
  assert.ok(Math.abs(west[0].rasterRect.west - (Math.PI - 0.01)) < 1e-12);
  assert.ok(Math.abs(west[0].rasterRect.east - (Math.PI + 0.05)) < 1e-12);

  const east = antimeridianWrapPasses({
    west: Math.PI - 0.05,
    south: 0.1,
    east: Math.PI + 0.01,
    north: 0.2,
  });
  assert.equal(east.length, 1);
  assert.equal(east[0].queryRect.west, -Math.PI);
  assert.ok(Math.abs(east[0].queryRect.east - (-Math.PI + 0.01)) < 1e-12);
  assert.ok(Math.abs(east[0].rasterRect.west - (-Math.PI - 0.05)) < 1e-12);

  assert.equal(
    antimeridianWrapPasses({ west: -4, south: 0, east: 4, north: 0.1 }).length,
    2,
  );
});

test("inside Chukotka, the tiles on both sides of the seam are all land: no shoreline along +-180", () => {
  const provider = loadProvider();
  let tiles = 0;
  for (const south of [66.4, 66.6, 66.8, 67.0, 67.2]) {
    const pair = seamPair(south);
    for (const side of ["west", "east"]) {
      const mask = provider.generateWaterMask(pair[side], SIZE);
      assert.equal(
        waterTexels(mask),
        0,
        `${side} tile at ${south} N has water texels`,
      );
      tiles++;
    }
  }
  assert.equal(tiles, 10);
});

test("across Fiji, the seam tiles agree at +-180 as closely as neighbouring texels inside each tile", () => {
  const provider = loadProvider();
  let coastal = 0;
  for (const south of [-17.0, -16.8, -16.6]) {
    const pair = seamPair(south);
    const a = provider.generateWaterMask(pair.west, SIZE);
    const b = provider.generateWaterMask(pair.east, SIZE);
    assert.equal(a.length, SIZE * SIZE, `west tile at ${south} is coastal`);
    assert.equal(b.length, SIZE * SIZE, `east tile at ${south} is coastal`);
    let seam = 0;
    let inner = 0;
    for (let r = 0; r < SIZE; r++) {
      seam = Math.max(seam, Math.abs(texel(a, r, SIZE - 1) - texel(b, r, 0)));
      inner = Math.max(
        inner,
        Math.abs(texel(a, r, SIZE - 2) - texel(a, r, SIZE - 1)),
        Math.abs(texel(b, r, 0) - texel(b, r, 1)),
      );
    }
    assert.ok(inner > 0, `the coast reaches the seam at ${south}`);
    assert.ok(
      seam <= inner,
      `seam step ${seam} exceeds the in-tile step ${inner} at ${south}`,
    );
    coastal++;
  }
  assert.equal(coastal, 3);
});

test("the augment path matches the generate path at the seam", () => {
  const provider = loadProvider();
  const allWater = () => new Uint8Array(SIZE * SIZE).fill(255);
  for (const south of [-16.8, 66.8]) {
    const pair = seamPair(south);
    for (const side of ["west", "east"]) {
      const generated = provider.generateWaterMask(pair[side], SIZE);
      const augmented = provider.augmentWaterMask(allWater(), pair[side], SIZE);
      assert.ok(augmented, `${side} tile at ${south} is augmented`);
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (texel(augmented, r, c) !== texel(generated, r, c)) {
            assert.fail(
              `${side} tile at ${south}: texel (${c}, ${r}) augmented ${texel(augmented, r, c)}, generated ${texel(generated, r, c)}`,
            );
          }
        }
      }
    }
  }
});
