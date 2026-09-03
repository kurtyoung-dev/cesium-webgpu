// @purpose Golden-byte and CRC32-vector coverage for Tools/lib/png-rgba.mjs.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import { crc32, encodeRgbaPng, pngChunk } from "./png-rgba.mjs";

// A 3x2 RGBA image chosen to exercise 0x00, 0xFF, and mid-range bytes in
// every channel (including alpha), so a filter-byte, chunk-order, or bit
// depth regression has somewhere to show up.
const WIDTH = 3;
const HEIGHT = 2;
const PIXELS = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255, 255, 255, 255,
  255, 0, 0, 0, 0,
]);

// Derived by running the same algorithm as the pre-existing
// `c12-31-aureole-gate.spec.mjs` encoder (crc32 + pngChunk + encodeRgbaPng,
// deflateSync at level 6) over PIXELS/WIDTH/HEIGHT above, and independently
// cross-checked against `probe-model-color.mjs` / `probe-oit-transparency.mjs`
// / `probe-gltf-points-mode.mjs`'s byte-identical `zlib.deflateSync(raw)`
// (default level) family — both produced this exact byte sequence.
const GOLDEN_PNG_BYTES = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0,
  0, 0, 2, 8, 6, 0, 0, 0, 157, 116, 102, 26, 0, 0, 0, 28, 73, 68, 65, 84, 120,
  156, 99, 248, 207, 192, 240, 159, 225, 63, 67, 3, 136, 98, 224, 18, 145, 251,
  15, 2, 12, 64, 0, 0, 128, 37, 9, 180, 142, 194, 116, 170, 0, 0, 0, 0, 73, 69,
  78, 68, 174, 66, 96, 130,
];

test("encodeRgbaPng produces the exact golden byte sequence", () => {
  const actual = Array.from(encodeRgbaPng(PIXELS, WIDTH, HEIGHT));
  assert.deepEqual(actual, GOLDEN_PNG_BYTES);
});

test("encodeRgbaPng output starts with the PNG signature and IHDR/IDAT/IEND in order", () => {
  const bytes = encodeRgbaPng(PIXELS, WIDTH, HEIGHT);
  assert.deepEqual(
    Array.from(bytes.subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const chunkTypeAt = (offset) =>
    String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  assert.equal(chunkTypeAt(8), "IHDR");
  const idatOffset = 8 + 25; // signature + IHDR chunk (13-byte payload + 12 overhead)
  assert.equal(chunkTypeAt(idatOffset), "IDAT");
  const idatLength = new DataView(
    bytes.buffer,
    bytes.byteOffset + idatOffset,
    4,
  ).getUint32(0);
  const iendOffset = idatOffset + 12 + idatLength;
  assert.equal(chunkTypeAt(iendOffset), "IEND");
  assert.equal(bytes.length, iendOffset + 12);
});

test("encodeRgbaPng IHDR declares 8-bit RGBA at the requested dimensions", () => {
  const bytes = encodeRgbaPng(PIXELS, WIDTH, HEIGHT);
  const ihdr = new DataView(bytes.buffer, bytes.byteOffset + 16, 13);
  assert.equal(ihdr.getUint32(0), WIDTH);
  assert.equal(ihdr.getUint32(4), HEIGHT);
  assert.equal(ihdr.getUint8(8), 8); // bit depth
  assert.equal(ihdr.getUint8(9), 6); // colour type: RGBA
});

test("crc32 matches the standard test vectors", () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("pngChunk length-prefixes, type-tags, and CRC-suffixes its payload", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const chunk = pngChunk("TEST", data);
  assert.equal(chunk.length, 12 + data.length);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.length);
  assert.equal(view.getUint32(0), data.length);
  assert.equal(String.fromCharCode(...chunk.subarray(4, 8)), "TEST");
  assert.deepEqual(
    Array.from(chunk.subarray(8, 8 + data.length)),
    [1, 2, 3, 4, 5],
  );
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(new TextEncoder().encode("TEST"));
  crcInput.set(data, 4);
  assert.equal(view.getUint32(8 + data.length), crc32(crcInput));
});

test("encodeRgbaPng is deterministic across repeated calls on the same input", () => {
  const first = encodeRgbaPng(PIXELS, WIDTH, HEIGHT);
  const second = encodeRgbaPng(PIXELS, WIDTH, HEIGHT);
  assert.deepEqual(Array.from(first), Array.from(second));
});
