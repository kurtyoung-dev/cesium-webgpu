// metrics-voxel-pick-coordinate.spec.mjs — behaviour spec for
// `lib/metrics/voxel-pick-coordinate.mjs`. Pure Node: no browser, no GPU.
// @purpose Behaviour spec for the voxel pick-readback decoder: hand-derived sample indices for the probes' own targets, the 255-base byte layout, atlas-slot inversion, and a differential leg against the retired probe copies.
// @status ACTIVE
//
// Every expected sample index below is derived in its comment from the
// formula `x + dimsX * (z + dimsZ * (dimsY - 1 - y))` for the probe's own
// staircase targets, not read back from the module. The differential cases
// run the four retired probe copies (transcribed below) beside the extraction.

import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeVoxelPickBytes,
  expectedVoxelSampleIndex,
  isClearedPick,
  levelOneOctantFromSlot,
  levelThreeTileFromSlot,
  pickBytesEqual,
  pickSampleBytesEqual,
  pickedColourMatches,
} from "./lib/metrics/voxel-pick-coordinate.mjs";

// ---------------------------------------------------------------------------
// The retired copies, transcribed.
// ---------------------------------------------------------------------------

/** `probe-voxel-cell-pick.mjs` `expectedSampleIndex`. */
function legacyExpectedSampleIndex(cell, dims) {
  const inX = dims.x;
  const inY = dims.z;
  const ix = cell.x;
  const iy = cell.z;
  const iz = dims.y - 1 - cell.y;
  return ix + inX * (iy + inY * iz);
}

/** `probe-voxel-refined-pick.mjs` `expectedSampleIndex` over a 4^3 tile. */
function legacyRefinedSampleIndex(cell) {
  const TILE = 4;
  return cell.x + TILE * (cell.z + TILE * (TILE - 1 - cell.y));
}

/** `probe-voxel-cell-pick.mjs` `decode`. */
function legacyDecode(bytes, dims) {
  if (!bytes) {
    return null;
  }
  const tile = 255 * bytes[0] + bytes[1];
  const sample = 255 * bytes[2] + bytes[3];
  const inX = dims.x;
  const inY = dims.z;
  const ix = sample % inX;
  const iy = Math.floor(sample / inX) % inY;
  const iz = Math.floor(sample / (inX * inY));
  return { tile, sample, cell: { x: ix, y: dims.y - 1 - iz, z: iy } };
}

/** `probe-voxel-cell-pick.mjs` Part B's WebGPU slot-to-octant clause. */
function legacyOctantMatches(slot, exp) {
  return (
    slot >= 1 &&
    slot <= 8 &&
    ((slot - 1) & 1) === exp.x &&
    (((slot - 1) >> 1) & 1) === exp.y &&
    (((slot - 1) >> 2) & 1) === exp.z
  );
}

/** `probe-voxel-cell-pick.mjs` Part D's `gpL3Tile`. */
function legacyL3Tile(slot, l3Slots) {
  if (!(slot >= 73) || !Array.isArray(l3Slots)) {
    return null;
  }
  const idx = l3Slots.indexOf(slot);
  if (idx < 0) {
    return null;
  }
  return {
    level: 3,
    x: idx % 8,
    y: Math.floor(idx / 8) % 8,
    z: Math.floor(idx / 64),
  };
}

/** `probe-voxel-pick.mjs` / `probe-voxel-refined-pick.mjs` `colorsEq`. */
function legacyColorsEq(a, b, eps) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

const STAIRCASE = { x: 2, y: 4, z: 3 };

// ---------------------------------------------------------------------------
// Hand-derived cases
// ---------------------------------------------------------------------------

test("expectedVoxelSampleIndex for the staircase probes' own targets", () => {
  // x + 2 * (z + 3 * (3 - y))
  assert.equal(expectedVoxelSampleIndex({ x: 1, y: 0, z: 0 }, STAIRCASE), 19); // 1 + 2*(0 + 9)
  assert.equal(expectedVoxelSampleIndex({ x: 1, y: 1, z: 1 }, STAIRCASE), 15); // 1 + 2*(1 + 6)
  assert.equal(expectedVoxelSampleIndex({ x: 1, y: 2, z: 2 }, STAIRCASE), 11); // 1 + 2*(2 + 3)
  assert.equal(expectedVoxelSampleIndex({ x: 0, y: 3, z: 1 }, STAIRCASE), 2); // 0 + 2*(1 + 0)
  // The refined probe's 4^3 child, local cell (3, k%4, k%4) for k = 7:
  // 3 + 4 * (3 + 4 * (3 - 3)) = 15
  const tile = { x: 4, y: 4, z: 4 };
  assert.equal(expectedVoxelSampleIndex({ x: 3, y: 3, z: 3 }, tile), 15);
});

test("decodeVoxelPickBytes reads 255-base tile and sample bytes and inverts the Y-up order", () => {
  // tile = 255*0 + 0 = 0; sample = 255*0 + 19 = 19 -> the (1,0,0) cell above.
  assert.deepEqual(decodeVoxelPickBytes([0, 0, 0, 19], STAIRCASE), {
    tile: 0,
    sample: 19,
    cell: { x: 1, y: 0, z: 0 },
  });
  // Base 255, not 256: [1, 2] -> 257, not 258.
  assert.equal(decodeVoxelPickBytes([1, 2, 0, 0], STAIRCASE).tile, 257);
  assert.equal(decodeVoxelPickBytes(null, STAIRCASE), null);
});

test("cleared, byte and sample-byte equality", () => {
  assert.equal(isClearedPick([0, 0, 0, 0]), true);
  assert.equal(isClearedPick([0, 0, 0, 1]), false);
  assert.equal(isClearedPick([0, 0, 0]), false);
  assert.equal(isClearedPick(null), false);
  assert.equal(pickBytesEqual([1, 2, 3, 4], [1, 2, 3, 4]), true);
  assert.equal(pickBytesEqual([1, 2, 3, 4], [1, 2, 3, 5]), false);
  assert.equal(pickBytesEqual(null, [1, 2, 3, 4]), false);
  assert.equal(pickSampleBytesEqual([9, 9, 3, 4], [1, 1, 3, 4]), true); // tile bytes ignored
  assert.equal(pickSampleBytesEqual([9, 9, 3, 4], [9, 9, 3, 5]), false);
});

test("levelOneOctantFromSlot maps slots 1..8 by x + 2y + 4z and nothing else", () => {
  assert.equal(levelOneOctantFromSlot(0), null); // the root
  assert.deepEqual(levelOneOctantFromSlot(1), { x: 0, y: 0, z: 0 }); // child 0
  assert.deepEqual(levelOneOctantFromSlot(8), { x: 1, y: 1, z: 1 }); // child 7
  assert.deepEqual(levelOneOctantFromSlot(6), { x: 1, y: 0, z: 1 }); // child 5 = 1 + 4
  assert.equal(levelOneOctantFromSlot(9), null);
  assert.equal(levelOneOctantFromSlot(NaN), null);
});

test("levelThreeTileFromSlot inverts l3Slots, whose index is x + 8y + 64z", () => {
  const l3Slots = new Array(512).fill(-1);
  l3Slots[7 + 8 * 2 + 64 * 5] = 400; // tile (7, 2, 5) lives in slot 400
  assert.deepEqual(levelThreeTileFromSlot(400, l3Slots), {
    level: 3,
    x: 7,
    y: 2,
    z: 5,
  });
  assert.equal(levelThreeTileFromSlot(72, l3Slots), null); // below the L3 base
  assert.equal(levelThreeTileFromSlot(401, l3Slots), null); // not resident
  assert.equal(levelThreeTileFromSlot(400, null), null);
});

test("pickedColourMatches is component-wise within epsilon, inclusive", () => {
  assert.equal(pickedColourMatches([0.5, 1], [0.5001, 1], 1e-4), true);
  assert.equal(pickedColourMatches([0.5, 1], [0.50011, 1], 1e-4), false);
  // At the bar itself: 0.625 - 0.5 is exactly 0.125 in binary floating point,
  // so a difference EQUAL to epsilon must match (inclusive), and one step past
  // it must not.
  assert.equal(pickedColourMatches([0.5, 1], [0.625, 1], 0.125), true);
  assert.equal(pickedColourMatches([0.5, 1], [0.6875, 1], 0.125), false);
  assert.equal(pickedColourMatches([0.5], [0.5, 1], 1), false);
});

// ---------------------------------------------------------------------------
// Differential cases
// ---------------------------------------------------------------------------

test("DIFFERENTIAL: decode and sample index equal the retired copies over every cell and byte", () => {
  for (const dims of [STAIRCASE, { x: 4, y: 4, z: 4 }, { x: 2, y: 2, z: 2 }]) {
    for (let x = 0; x < dims.x; x++) {
      for (let y = 0; y < dims.y; y++) {
        for (let z = 0; z < dims.z; z++) {
          const cell = { x, y, z };
          const sample = expectedVoxelSampleIndex(cell, dims);
          assert.equal(sample, legacyExpectedSampleIndex(cell, dims));
          if (dims.x === 4) {
            assert.equal(sample, legacyRefinedSampleIndex(cell));
          }
          // The index round-trips through the readback encoding.
          const bytes = [0, 3, Math.floor(sample / 255), sample % 255];
          assert.deepEqual(decodeVoxelPickBytes(bytes, dims).cell, cell);
        }
      }
    }
  }
  for (let hi = 0; hi < 256; hi += 17) {
    for (let lo = 0; lo < 256; lo += 13) {
      const bytes = [hi, lo, lo, hi];
      assert.deepEqual(
        decodeVoxelPickBytes(bytes, STAIRCASE),
        legacyDecode(bytes, STAIRCASE),
      );
    }
  }
});

test("DIFFERENTIAL: slot inversions and the colour comparison equal the retired copies", () => {
  const octants = [];
  for (let i = 0; i < 8; i++) {
    octants.push({ x: i & 1, y: (i >> 1) & 1, z: (i >> 2) & 1 });
  }
  for (let slot = -1; slot <= 12; slot++) {
    for (const exp of octants) {
      const octant = levelOneOctantFromSlot(slot);
      const matches =
        octant !== null &&
        octant.x === exp.x &&
        octant.y === exp.y &&
        octant.z === exp.z;
      assert.equal(matches, legacyOctantMatches(slot, exp));
    }
  }
  const l3Slots = Array.from({ length: 512 }, (_, i) =>
    i % 3 === 0 ? 73 + i : -1,
  );
  for (let slot = 60; slot < 600; slot++) {
    assert.deepEqual(
      levelThreeTileFromSlot(slot, l3Slots),
      legacyL3Tile(slot, l3Slots),
    );
  }
  for (const [a, b] of [
    [
      [0.35, 0.15, 0.2, 1],
      [0.35, 0.15, 0.20005, 1],
    ],
    [
      [1, 0],
      [1, 0.006],
    ],
    [[1], [1, 1]],
  ]) {
    for (const eps of [1e-4, 5e-3]) {
      assert.equal(pickedColourMatches(a, b, eps), legacyColorsEq(a, b, eps));
    }
  }
});
