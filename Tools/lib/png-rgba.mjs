/**
 * Shared RGBA-to-PNG encoding primitives for the visual-regression probe fleet.
 * @purpose CRC32 + PNG chunk + zero-dependency RGBA PNG encoder shared across the probe fleet, replacing near-duplicate hand-rolled copies one consumer at a time.
 * @status ACTIVE
 *
 * A census (`migration_doc/QUEUE_2026-08-29_RESEARCH_DISPATCH.md`, DX-16) found
 * dozens of `Tools/visual-regression/probe-*.mjs` files each carrying their own
 * copy of the same CRC32 table, PNG chunk wrapper, and RGBA encoder — a single
 * `zlib.deflateSync` compression scheme (default level, which resolves to
 * level 6) reproduced by hand in every probe that writes a diagnostic PNG.
 * This module is the one home for that scheme; callers pass RGBA bytes in,
 * get PNG bytes out, and do their own file I/O.
 *
 * Not every existing encoder in the fleet uses this scheme — a smaller family
 * (`Tools/visual-regression/capture-and-diff.mjs`,
 * `Tools/visual-regression/lib/celestial-capture-harness.mjs`,
 * `Tools/visual-regression/probe-reproject-baseline.mjs`) writes stored
 * (uncompressed) zlib blocks instead of calling `deflateSync`, which is a
 * different byte stream for the same pixels even though both decode to the
 * same image. `Tools/readme-screenshots/capture-readme-screenshots.spec.mjs`,
 * `Tools/stbn-bake/stbn-png.mjs`, and
 * `Tools/visual-regression/probe-daynight-terminator-law.mjs` encode non-RGBA
 * color types (truecolour, greyscale, and truecolour-without-alpha
 * respectively — the last one still calls `deflateSync`, but with 3
 * bytes/pixel, not 4) and are not RGBA encoders at all. None of those are
 * consumers of `encodeRgbaPng` — swapping them in would change the bytes
 * they produce.
 *
 * @module Tools/lib/png-rgba
 */

import { deflateSync } from "node:zlib";

// Not frozen: V8 rejects Object.freeze on a non-empty typed array (its
// indexed elements can't be made non-configurable), and this module never
// mutates the signature anyway.
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// Standard CRC-32 (IEEE 802.3 / zlib polynomial 0xEDB88320) lookup table.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

/**
 * CRC-32 (IEEE 802.3 / zlib polynomial) over a byte sequence, matching the
 * checksum PNG chunks and zlib both use.
 *
 * @param {Uint8Array} bytes
 * @returns {number} Unsigned 32-bit CRC.
 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Wrap `data` as one PNG chunk: 4-byte length, 4-byte ASCII type, the data,
 * then a CRC32 over type+data.
 *
 * @param {string} type Four-character chunk type (e.g. "IHDR", "IDAT").
 * @param {Uint8Array} data
 * @returns {Uint8Array} The complete chunk, length-prefixed and CRC-suffixed.
 */
export function pngChunk(type, data) {
  const length = data.length;
  const out = new Uint8Array(12 + length);
  const view = new DataView(out.buffer);
  view.setUint32(0, length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + length);
  crcInput.set(out.subarray(4, 8 + length));
  view.setUint32(8 + length, crc32(crcInput));
  return out;
}

/**
 * Encode a raw RGBA buffer (8-bit, no interlacing, one scanline filter byte
 * of 0 per row) to a PNG. IDAT is `zlib.deflateSync` at level 6.
 *
 * @param {Uint8Array} pixels Tightly packed RGBA bytes, `width * height * 4` long.
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} Complete PNG file bytes.
 */
export function encodeRgbaPng(pixels, width, height) {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha (RGBA)
  // ihdr[10..12] (compression/filter/interlace) stay 0 — the only PNG values.

  const stride = width * 4;
  const scanlines = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    scanlines[rowStart] = 0; // filter type: none
    scanlines.set(pixels.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }

  const idat = deflateSync(scanlines, { level: 6 });

  const ihdrChunk = pngChunk("IHDR", ihdr);
  const idatChunk = pngChunk("IDAT", idat);
  const iendChunk = pngChunk("IEND", new Uint8Array(0));

  const out = new Uint8Array(
    PNG_SIGNATURE.length +
      ihdrChunk.length +
      idatChunk.length +
      iendChunk.length,
  );
  out.set(PNG_SIGNATURE, 0);
  out.set(ihdrChunk, PNG_SIGNATURE.length);
  out.set(idatChunk, PNG_SIGNATURE.length + ihdrChunk.length);
  out.set(
    iendChunk,
    PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length,
  );
  return out;
}
