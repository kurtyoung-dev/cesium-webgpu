// @purpose Round-trip, filter-coverage and error-path coverage for Tools/lib/png-decode.mjs.
// @status ACTIVE
//
// DX-16 follow-up: this module was moved unchanged (function bodies are
// byte-identical, only the header/JSDoc differ — see the module's own header
// note) from `Tools/visual-regression/lib/pnglite.mjs`, which shipped at
// Batch 1375 with no spec of its own. Its only prior exercise was indirect,
// through `probe-gpucull-blackframe-isolation.mjs`'s Playwright-produced
// screenshots — never pinned against known bytes. This file is the pin.
//
// Group A round-trips `decodePng` against the sibling encoder
// (`Tools/lib/png-rgba.mjs`'s `encodeRgbaPng`) for the three RGBA buffers the
// DX-16 dispatch names (1x1, a 7x3 gradient, a 64x64 seeded-noise buffer),
// which only ever exercises filter type 0 (`encodeRgbaPng` always writes
// filter-none rows). Group B covers what that round trip cannot reach: each
// of the four other PNG filter types (Sub/Up/Average/Paeth), built by a
// forward filter encoder in this file (`predictor()`, below) that is
// textually independent of `decodePng`'s own un-filter loop. That
// independence is one-sided, not a proof against a shared defect: both
// formulas were written from the same reading of the PNG spec, in the same
// file, so a mirrored misreading of the Paeth predictor passes both sides
// undetected (station-3 review, Ingold, FIX-3 — mutant M9 confirmed this:
// the same wrong predictor applied to `decodePng` and to `predictor()` left
// the suite green). Group F closes that gap with a PNG this file never
// chose the filter bytes of: `sharp` (libspng; already a devDependency,
// `package.json:113`), whose `adaptiveFiltering` selects each row's filter
// type independently, decoded here and compared against the exact raw
// bytes it was built from. Group C is colour type 2 (RGB, no alpha channel
// in the file), which `encodeRgbaPng` never writes either. Group D covers
// `diffPixels` and `frameStats`. Group E is the structural error paths (bad
// signature, unsupported bit depth, interlaced, unsupported colour type).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync as zlibDeflate } from "node:zlib";

import sharp from "sharp";

import { encodeRgbaPng, pngChunk } from "./png-rgba.mjs";
import { decodePng, diffPixels, frameStats, readPng } from "./png-decode.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// Fixtures: the three RGBA buffers named in the DX-16 dispatch.
// ---------------------------------------------------------------------------

function seededNoise(width, height, seed) {
  // Deterministic LCG (Numerical Recipes constants) — no crypto RNG needed,
  // just a fixed, reproducible byte stream.
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24; // top byte
  };
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = next();
  return pixels;
}

function gradient(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      pixels[o] = Math.round((x / (width - 1)) * 255);
      pixels[o + 1] = Math.round((y / (height - 1)) * 255);
      pixels[o + 2] = 255 - pixels[o];
      pixels[o + 3] = 255;
    }
  }
  return pixels;
}

const FIXTURES = [
  {
    name: "1x1",
    width: 1,
    height: 1,
    pixels: new Uint8Array([12, 200, 5, 255]),
  },
  { name: "7x3 gradient", width: 7, height: 3, pixels: gradient(7, 3) },
  {
    name: "64x64 seeded noise",
    width: 64,
    height: 64,
    pixels: seededNoise(64, 64, 0xc0ffee),
  },
];

// ---------------------------------------------------------------------------
// A. Round trip through the sibling encoder (filter type 0 only).
// ---------------------------------------------------------------------------

for (const fixture of FIXTURES) {
  test(`A: decodePng(encodeRgbaPng(${fixture.name})) reproduces the input bytes exactly`, () => {
    // encodeRgbaPng's contract returns a Uint8Array; decodePng's contract
    // takes a Buffer (it calls Buffer-only methods — readUInt32BE, toString,
    // subarray — not just the Uint8Array surface). Real call sites always
    // cross this boundary through actual file I/O (fs.writeFileSync accepts
    // a Uint8Array, fs.readFileSync always returns a Buffer), so this Buffer
    // wrap is that same boundary made explicit in-memory.
    const png = Buffer.from(
      encodeRgbaPng(fixture.pixels, fixture.width, fixture.height),
    );
    const decoded = decodePng(png);
    assert.equal(decoded.width, fixture.width);
    assert.equal(decoded.height, fixture.height);
    assert.deepEqual(Array.from(decoded.data), Array.from(fixture.pixels));
    // The sha256 pair a landing packet can quote: same digest both sides
    // proves byte identity without printing the whole buffer.
    assert.equal(sha256(decoded.data), sha256(fixture.pixels));
  });
}

// ---------------------------------------------------------------------------
// B. Filter-type coverage, textually independent of decodePng's own
// un-filter loop (see the header note above for why that is not the same
// as independent against a shared defect — Group F below closes that gap).
// ---------------------------------------------------------------------------

/** Forward (encode-direction) predictor — the inverse of decodePng's per-filter branch. */
function predictor(filterType, a, b, c) {
  if (filterType === 0) return 0;
  if (filterType === 1) return a;
  if (filterType === 2) return b;
  if (filterType === 3) return (a + b) >> 1;
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Encode raw (unfiltered) rows to PNG scanline bytes, one filter type per row.
 *
 * @param {Uint8Array[]} rawRows One `width * channels`-byte row per entry.
 * @param {number} channels 3 or 4.
 * @param {number[]} filterPerRow One PNG filter type (0-4) per row.
 * @returns {Buffer} Unfiltered-plus-filter-byte scanline stream (pre-deflate).
 */
function encodeScanlines(rawRows, channels, filterPerRow) {
  const stride = rawRows[0].length;
  const out = Buffer.alloc(rawRows.length * (stride + 1));
  let previous = new Uint8Array(stride);
  for (let y = 0; y < rawRows.length; y++) {
    const filterType = filterPerRow[y];
    const row = rawRows[y];
    const rowStart = y * (stride + 1);
    out[rowStart] = filterType;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      out[rowStart + 1 + x] = (row[x] - predictor(filterType, a, b, c)) & 0xff;
    }
    previous = row;
  }
  return out;
}

function buildPng({
  width,
  height,
  colorType,
  channels,
  rawRows,
  filterPerRow,
}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  const scanlines = encodeScanlines(rawRows, channels, filterPerRow);
  const idat = zlibDeflate(scanlines);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from(pngChunk("IHDR", ihdr)),
    Buffer.from(pngChunk("IDAT", idat)),
    Buffer.from(pngChunk("IEND", new Uint8Array(0))),
  ]);
}

function rawRgbaRow(y, width) {
  const row = new Uint8Array(width * 4);
  for (let x = 0; x < width; x++) {
    const o = x * 4;
    row[o] = (x * 37 + y * 53) % 256;
    row[o + 1] = (x * 61 + y * 17 + 11) % 256;
    row[o + 2] = (x * 5 + y * 97 + 23) % 256;
    row[o + 3] = (x * 13 + y * 29 + 41) % 256;
  }
  return row;
}

test("B: decodePng reconstructs each PNG filter type (0-4) correctly", () => {
  const width = 4;
  const height = 5; // one row per filter type, 0 through 4
  const channels = 4;
  const rawRows = Array.from({ length: height }, (_, y) =>
    rawRgbaRow(y, width),
  );
  const filterPerRow = [0, 1, 2, 3, 4];
  const png = buildPng({
    width,
    height,
    colorType: 6,
    channels,
    rawRows,
    filterPerRow,
  });
  const decoded = decodePng(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  const expected = Buffer.concat(rawRows.map((row) => Buffer.from(row)));
  assert.deepEqual(Array.from(decoded.data), Array.from(expected));
});

// ---------------------------------------------------------------------------
// F. External oracle: a PNG whose filter bytes decodePng and predictor()
// never chose. `sharp` (libspng) picks the per-row filter itself under
// `adaptiveFiltering` — station-3 review (Ingold, §3c) measured filter
// types 1 and 4 in the inflated IDAT for the 7x3 and 64x64 fixtures below,
// so this exercises the same Sub/Paeth branches Group B exercises, but
// against bytes this file did not choose. A mirrored Paeth mistake that
// passes Group A and Group B (mutant M9) cannot pass this: sharp's own
// encoder has no relationship to decodePng's formula.
// ---------------------------------------------------------------------------

for (const fixture of FIXTURES) {
  test(`F: decodePng(sharp-encoded ${fixture.name}) reproduces the input bytes exactly`, async () => {
    const png = await sharp(Buffer.from(fixture.pixels), {
      raw: { width: fixture.width, height: fixture.height, channels: 4 },
    })
      .png({ adaptiveFiltering: true, compressionLevel: 9 })
      .toBuffer();
    const decoded = decodePng(png);
    assert.equal(decoded.width, fixture.width);
    assert.equal(decoded.height, fixture.height);
    assert.deepEqual(Array.from(decoded.data), Array.from(fixture.pixels));
    assert.equal(sha256(decoded.data), sha256(fixture.pixels));
  });
}

// ---------------------------------------------------------------------------
// C. Colour type 2 (RGB, no alpha) — decodePng must synthesize alpha = 255.
// ---------------------------------------------------------------------------

test("C: decodePng fills alpha=255 for colour type 2 (RGB) input", () => {
  const width = 3;
  const height = 2;
  const channels = 3;
  const rawRows = [
    Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90]),
    Uint8Array.from([100, 110, 120, 130, 140, 150, 160, 170, 180]),
  ];
  const png = buildPng({
    width,
    height,
    colorType: 2,
    channels,
    rawRows,
    filterPerRow: [0, 2],
  });
  const decoded = decodePng(png);
  assert.equal(decoded.data.length, width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcOffset = x * channels;
      const dstOffset = (y * width + x) * 4;
      assert.equal(decoded.data[dstOffset], rawRows[y][srcOffset]);
      assert.equal(decoded.data[dstOffset + 1], rawRows[y][srcOffset + 1]);
      assert.equal(decoded.data[dstOffset + 2], rawRows[y][srcOffset + 2]);
      assert.equal(decoded.data[dstOffset + 3], 255);
    }
  }
});

// ---------------------------------------------------------------------------
// D. diffPixels / frameStats.
// ---------------------------------------------------------------------------

test("D1: diffPixels reports zero mismatch for identical images", () => {
  const png = Buffer.from(encodeRgbaPng(gradient(5, 5), 5, 5));
  const a = decodePng(png);
  const b = decodePng(png);
  const result = diffPixels(a, b);
  assert.equal(result.comparable, true);
  assert.equal(result.differing, 0);
  assert.equal(result.mismatchPct, 0);
  assert.equal(result.maxDelta, 0);
});

test("D2: diffPixels counts pixels whose max-channel delta exceeds tolerance", () => {
  const width = 2;
  const height = 1;
  const a = {
    width,
    height,
    data: Buffer.from([0, 0, 0, 255, 100, 100, 100, 255]),
  };
  // Pixel 0 shifted by 5 (<= default tolerance 8, not counted); pixel 1
  // shifted by 50 (> tolerance, counted).
  const b = {
    width,
    height,
    data: Buffer.from([5, 5, 5, 255, 150, 100, 100, 255]),
  };
  const result = diffPixels(a, b);
  assert.equal(result.comparable, true);
  assert.equal(result.differing, 1);
  assert.equal(result.mismatchPct, 50);
  assert.equal(result.maxDelta, 50);
});

test("D3: diffPixels refuses to compare mismatched sizes", () => {
  const a = { width: 2, height: 2, data: Buffer.alloc(16) };
  const b = { width: 3, height: 2, data: Buffer.alloc(24) };
  const result = diffPixels(a, b);
  assert.equal(result.comparable, false);
  assert.match(result.reason, /size mismatch 2x2 vs 3x2/);
});

test("D4: frameStats reads luminance and non-black fraction from a known image", () => {
  // Half the pixels pure black, half pure white.
  const width = 4;
  const height = 1;
  const data = Buffer.alloc(width * height * 4);
  for (let x = 0; x < width; x++) {
    const o = x * 4;
    const v = x < 2 ? 0 : 255;
    data[o] = v;
    data[o + 1] = v;
    data[o + 2] = v;
    data[o + 3] = 255;
  }
  const stats = frameStats({ width, height, data });
  assert.equal(stats.nonBlackPct, 50);
  // Floating-point sum of per-pixel luminance, not an exact binary fraction —
  // compare within an epsilon far tighter than any real regression would be.
  assert.ok(
    Math.abs(stats.meanLuminance - 127.5) < 1e-6,
    `meanLuminance ${stats.meanLuminance} not within epsilon of 127.5`,
  );
});

test("D5: readPng decodes a file written by encodeRgbaPng", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "png-decode-spec-"));
  const filePath = path.join(dir, "fixture.png");
  try {
    const pixels = gradient(6, 4);
    writeFileSync(filePath, encodeRgbaPng(pixels, 6, 4));
    const decoded = readPng(filePath);
    assert.equal(decoded.width, 6);
    assert.equal(decoded.height, 4);
    assert.deepEqual(Array.from(decoded.data), Array.from(pixels));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E. Structural error paths.
// ---------------------------------------------------------------------------

function buildHeaderOnlyPng({ bitDepth = 8, colorType = 6, interlace = 0 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from(pngChunk("IHDR", ihdr)),
  ]);
}

test("E1: decodePng rejects a buffer without the PNG signature", () => {
  assert.throws(() => decodePng(Buffer.from([1, 2, 3, 4])), /not a PNG/);
});

test("E2: decodePng rejects a bit depth other than 8", () => {
  assert.throws(
    () => decodePng(buildHeaderOnlyPng({ bitDepth: 16 })),
    /unsupported bit depth 16/,
  );
});

test("E3: decodePng rejects an interlaced image", () => {
  assert.throws(
    () => decodePng(buildHeaderOnlyPng({ interlace: 1 })),
    /interlaced PNG unsupported/,
  );
});

test("E4: decodePng rejects an unsupported colour type", () => {
  assert.throws(
    () => decodePng(buildHeaderOnlyPng({ colorType: 3 })),
    /unsupported colour type 3/,
  );
});
