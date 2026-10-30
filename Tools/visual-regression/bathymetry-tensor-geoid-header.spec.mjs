// bathymetry-tensor-geoid-header.spec.mjs - the bathymetry tensor builder reads the EGM2008 grid after its header.
// @purpose Pins that Tools/build-global-bathymetry-tensor.mjs places geoid features at their own longitude (the 32-byte EGM1 header is skipped, not read as samples) and that the shipped tensor carries no header-leak trenches at the poles.
// @status ACTIVE
//
// The defect (seat row NEW-WATER-GEOID-HEADER-OFFSET): the builder read
// `Assets/Geoid/egm2008-0p5deg.i16` as raw int16 from byte 0. The file starts
// with a 32-byte header, so the first 16 samples were header bytes ("EG" read
// as 182.45 m) and every node sat 16 columns (8 deg) east of where it belongs.
// The shipped tensor carried both: an 8 deg shift of the geoid-driven shelf,
// trench and ridge terms, and 10,154 m "trenches" along the north-pole row.
//
// Run: node --test Tools/visual-regression/bathymetry-tensor-geoid-header.spec.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createGeoidNodeReader,
  geoidTermsAtCell,
} from "../build-global-bathymetry-tensor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");

const NX = 721;
const NY = 361;
const BACKGROUND_CM = 1000; // 10 m everywhere but the bump
const BUMP_CM = 6000; // 60 m at one node
const BUMP_ROW = 120; // 30 N
const BUMP_COL = 400; // 20 E

// A synthetic EGM1 grid in the format of Tools/build-geoid-undulation-grid.mjs:
// 32-byte little-endian header, then NX*NY int16 centimetres, north row first.
function syntheticGrid({ magic = 0x314d4745, nx = NX, ny = NY } = {}) {
  const bytes = new Uint8Array(32 + nx * ny * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, 100, true);
  view.setUint32(8, nx, true);
  view.setUint32(12, ny, true);
  view.setInt32(16, -180000000, true);
  view.setInt32(20, 90000000, true);
  view.setUint32(24, 500000, true);
  for (let i = 0; i < nx * ny; i++) {
    view.setInt16(32 + i * 2, BACKGROUND_CM, true);
  }
  if (nx === NX && ny === NY) {
    view.setInt16(32 + (BUMP_ROW * NX + BUMP_COL) * 2, BUMP_CM, true);
  }
  return bytes;
}

test("a geoid feature lands on its own tensor column, not 16 columns (8 deg) away", () => {
  const node = createGeoidNodeReader(syntheticGrid());
  const at = geoidTermsAtCell(node, BUMP_ROW, BUMP_COL);
  assert.equal(at.undulation, 60);
  // A 50 m spike over a flat background: the Laplacian is -4 x 50 m.
  assert.ok(
    Math.abs(at.laplacian + 200) < 1e-9,
    `Laplacian at the bump ${at.laplacian}`,
  );
  // Wherever a byte-0 read would have put it, the field is flat.
  for (const c of [BUMP_COL - 16, BUMP_COL + 16]) {
    const off = geoidTermsAtCell(node, BUMP_ROW, c);
    assert.equal(off.undulation, 10, `column ${c}`);
    assert.equal(off.laplacian, 0, `column ${c}`);
  }
  // Its four neighbours see it in their Laplacian and slope, and nothing else does.
  let touched = 0;
  for (let r = BUMP_ROW - 3; r <= BUMP_ROW + 3; r++) {
    for (let c = BUMP_COL - 20; c <= BUMP_COL + 20; c++) {
      if (geoidTermsAtCell(node, r, c).slope > 0) {
        touched++;
      }
    }
  }
  assert.equal(touched, 4);
});

test("the header bytes never reach a sample: the north-west corner reads the background", () => {
  const node = createGeoidNodeReader(syntheticGrid());
  for (let c = 0; c < 20; c++) {
    assert.equal(node(0, c), 10, `node (0, ${c})`);
  }
  for (let c = 0; c < 20; c++) {
    const terms = geoidTermsAtCell(node, 0, c);
    assert.equal(terms.undulation, 10, `cell (0, ${c})`);
    assert.equal(terms.laplacian, 0, `cell (0, ${c})`);
  }
});

test("a grid that is not EGM1, or not the global 721x361 grid, is refused", () => {
  assert.throws(() => createGeoidNodeReader(syntheticGrid({ magic: 0 })));
  assert.throws(
    () => createGeoidNodeReader(syntheticGrid({ nx: 361, ny: 181 })),
    /721x361/,
  );
});

test("the bundled grid reads the published undulation at the node the engine samples", () => {
  const bytes = fs.readFileSync(
    path.join(ROOT, "packages/engine/Source/Assets/Geoid/egm2008-0p5deg.i16"),
  );
  const node = createGeoidNodeReader(bytes);
  // The engine path (Core/GeoidUndulationGrid.js) reads the payload from byte
  // 32; this is the same int16 read straight from the file, independently.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [row, col] of [
    [0, 0],
    [0, 15],
    [180, 0],
    [180, 360],
    [184, 514], // 2 S, 77 E: the Indian Ocean geoid low
    [360, 720],
  ]) {
    const expected = view.getInt16(32 + (row * NX + col) * 2, true) * 0.01;
    assert.equal(node(row, col), expected, `node (${row}, ${col})`);
  }
  // The Indian Ocean geoid low is about -100 m near 2 S, 77 E. Read 16
  // columns east (the old byte-0 offset) it would sit near 85 E instead.
  assert.ok(node(184, 514) < -90, `undulation ${node(184, 514)}`);
});

test("the shipped tensor has no header-leak trenches: no cell poleward of 70 deg is deeper than 6 km", () => {
  const buf = fs.readFileSync(
    path.join(
      ROOT,
      "packages/engine/Source/Assets/WaterMask/globalBathymetryTensor.bin",
    ),
  );
  const width = buf.readUInt16LE(4);
  const height = buf.readUInt16LE(6);
  const deep = [];
  for (let r = 0; r < height; r++) {
    const lat = 90 - (r + 0.5) * (180 / height);
    if (Math.abs(lat) < 70) {
      continue;
    }
    for (let c = 0; c < width; c++) {
      const depth = (buf[12 + (r * width + c) * 4] / 255) ** 2 * 11000;
      if (depth > 6000) {
        deep.push(`${lat}, ${-180 + (c + 0.5) * (360 / width)}: ${depth}`);
      }
    }
  }
  assert.deepEqual(deep, []);
});
