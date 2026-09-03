/**
 * Shared PNG-to-RGBA decoding and pixel-analysis primitives for the
 * visual-regression probe fleet.
 * @purpose Dependency-free PNG decoder (8-bit, non-interlaced, colour type 2 or 6) plus pixel-diff and frame-stats helpers, the decode-side counterpart of Tools/lib/png-rgba.mjs.
 * @status ACTIVE
 *
 * DX-16 follow-up (ruling R-2026-09-02-17, "one PNG/CRC32 helper in
 * Tools/lib"): this module was `Tools/visual-regression/lib/pnglite.mjs`,
 * landed at Batch 1375 as the reproducer for
 * `probe-gpucull-blackframe-isolation.mjs`. Re-reading it at fold time found
 * it carries no PNG encoder at all — `crc32`/`pngChunk`/`encodeRgbaPng` live
 * only in `png-rgba.mjs`, and this file's `decodePng`/`readPng` are a decoder,
 * with `diffPixels`/`frameStats` downstream pixel analysis. The two modules
 * are complementary (encode vs. decode), not duplicates, so nothing here
 * changed byte-for-byte in the move — see `png-decode.spec.mjs` for the
 * round-trip proof against `encodeRgbaPng`. Moved so a decoder that reads
 * arbitrary screenshots (Playwright's own PNG encoder, which uses adaptive
 * per-row filtering, not the fixed filter-0 rows `encodeRgbaPng` writes) has
 * the same durable home as its encode-side sibling, rather than living under
 * `Tools/visual-regression/lib/` where only one probe could see it.
 *
 * @module Tools/lib/png-decode
 */

import zlib from "node:zlib";
import fs from "node:fs";

function crcCheckSkip() {
  /* CRCs are not validated — the producer is Playwright, not a network. */
}

/**
 * Decode an 8-bit, non-interlaced PNG (colour type 2 RGB or 6 RGBA) to a
 * tightly packed RGBA buffer.
 *
 * @param {Buffer} buffer Complete PNG file bytes.
 * @returns {{width: number, height: number, data: Buffer}} Decoded image;
 *   `data` is `width * height * 4` bytes, RGB inputs get alpha 255.
 */
export function decodePng(buffer) {
  crcCheckSkip();
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    throw new Error("not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  // Bounded: every iteration advances `offset` by at least 12 bytes.
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === "IDAT") {
      idat.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG unsupported");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const line = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value = (value + a) & 0xff;
      else if (filter === 2) value = (value + b) & 0xff;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        value = (value + pr) & 0xff;
      }
      line[x] = value;
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = line[src];
      out[dst + 1] = line[src + 1];
      out[dst + 2] = line[src + 2];
      out[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    previous = line;
  }
  return { width, height, data: out };
}

/**
 * Read and decode a PNG file from disk.
 *
 * @param {string} filePath Path to a PNG file.
 * @returns {{width: number, height: number, data: Buffer}} Decoded image.
 */
export function readPng(filePath) {
  return decodePng(fs.readFileSync(filePath));
}

/**
 * Per-pixel mismatch fraction. A pixel counts as different when any channel
 * moves by more than `tolerance`. Also returns mean absolute channel delta so
 * a sub-threshold but systematic shift is visible instead of rounding to zero.
 *
 * @param {{width: number, height: number, data: Buffer|Uint8Array}} a First image.
 * @param {{width: number, height: number, data: Buffer|Uint8Array}} b Second image.
 * @param {number} [tolerance] Per-channel delta above which a pixel counts as differing.
 * @returns {{comparable: boolean, reason?: string, total?: number, differing?: number, mismatchPct?: number, meanAbsDelta?: number, maxDelta?: number}} Comparison.
 */
export function diffPixels(a, b, tolerance = 8) {
  if (a.width !== b.width || a.height !== b.height) {
    return {
      comparable: false,
      reason: `size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`,
    };
  }
  const total = a.width * a.height;
  let differing = 0;
  let sum = 0;
  let maxDelta = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const dr = Math.abs(a.data[o] - b.data[o]);
    const dg = Math.abs(a.data[o + 1] - b.data[o + 1]);
    const db = Math.abs(a.data[o + 2] - b.data[o + 2]);
    const d = Math.max(dr, dg, db);
    if (d > maxDelta) maxDelta = d;
    sum += (dr + dg + db) / 3;
    if (d > tolerance) differing++;
  }
  return {
    comparable: true,
    total,
    differing,
    mismatchPct: (differing / total) * 100,
    meanAbsDelta: sum / total,
    maxDelta,
  };
}

/**
 * Fraction of pixels that are not near-black, plus mean luminance.
 *
 * @param {{width: number, height: number, data: Buffer|Uint8Array}} img Decoded image.
 * @param {number} [blackThreshold] Per-channel value above which a pixel counts as non-black.
 * @returns {{width: number, height: number, nonBlackPct: number, meanLuminance: number, distinctCoarseColors: number}} Stats.
 */
export function frameStats(img, blackThreshold = 12) {
  const total = img.width * img.height;
  let nonBlack = 0;
  let lum = 0;
  const hist = new Map();
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const r = img.data[o];
    const g = img.data[o + 1];
    const b = img.data[o + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum += l;
    if (r > blackThreshold || g > blackThreshold || b > blackThreshold)
      nonBlack++;
    if (i % 97 === 0) {
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
  }
  return {
    width: img.width,
    height: img.height,
    nonBlackPct: (nonBlack / total) * 100,
    meanLuminance: lum / total,
    distinctCoarseColors: hist.size,
  };
}
