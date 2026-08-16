// stbn-png.mjs — minimal 8-bit greyscale PNG encoder + decoder for the STBN
// bake (C13-11).
// @purpose Minimal spec-derived 8-bit greyscale PNG encoder/decoder so the STBN bake and its node:test spec need no native image dependency.
// @status ACTIVE
//
// PROVENANCE DISCIPLINE. Written from the PNG specification (W3C/ISO
// 15948:2004: signature, chunk layout, IHDR fields, filter types 0-4, and the
// CRC-32 defined in the spec's Annex D) and RFC 1950/1951 for the zlib
// container, which `node:zlib` supplies. No encoder or decoder source was
// consulted or copied.
//
// WHY NOT `sharp`. The sibling `Tools/moon-albedo-bake/` uses `sharp`, and for
// a 5760x2880 float32 GeoTIFF that is the right call. This tool needs exactly
// one format — 8-bit greyscale, non-interlaced, no palette, no ancillary
// chunks — in both directions, and it needs the DECODER inside a `node --test`
// spec that has to run without a native binary being present. ~200 lines of
// spec-derived code buys a validation gate with zero install surface.
//
// SCOPE. `encodeGray8` writes exactly one shape: colour type 0, bit depth 8,
// no interlace, filter type 0 (None) on every scanline. `decodeGray8` reads
// that shape back and ALSO accepts filter types 1-4 on input, so a future
// re-encode by some other tool still validates instead of throwing.
//
// Linted by the `Tools/**` block in eslint.config.js.

import zlib from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// CRC-32 as specified in PNG Annex D (the ISO-HDLC / zlib polynomial in
// reflected form, 0xEDB88320). The table is derived here rather than pasted:
// entry n is the CRC of the single byte n.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * PNG CRC-32 over a buffer.
 * @param {Buffer} buf bytes to checksum
 * @returns {number} the CRC as an unsigned 32-bit integer
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build one PNG chunk: length, type, data, CRC over type+data.
 * @param {string} type four ASCII characters
 * @param {Buffer} data chunk payload
 * @returns {Buffer} the framed chunk
 */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
}

/**
 * Encode an 8-bit greyscale image.
 *
 * Every scanline uses filter type 0 (None). Blue noise is by construction
 * uncorrelated with its neighbours, so the predictive filters cannot help —
 * and None makes the byte stream a direct function of the pixels, which keeps
 * the encode auditable: strip the 8-byte signature and the chunk framing and
 * the IDAT payload inflates to exactly `height * (1 + width)` bytes with a
 * zero before every row.
 *
 * @param {Uint8Array} pixels row-major, `width * height` bytes
 * @param {number} width image width in pixels
 * @param {number} height image height in pixels
 * @param {number} [level=9] zlib compression level
 * @returns {Buffer} the complete PNG file
 */
export function encodeGray8(pixels, width, height, level = 9) {
  if (pixels.length !== width * height) {
    throw new Error(
      `encodeGray8: expected ${width * height} bytes, got ${pixels.length}`,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0 = greyscale
  ihdr[10] = 0; // compression method 0 = deflate
  ihdr[11] = 0; // filter method 0 = adaptive (per-scanline filter byte)
  ihdr[12] = 0; // interlace method 0 = none

  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (width + 1);
    raw[dst] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      raw[dst + 1 + x] = pixels[y * width + x];
    }
  }

  const idat = zlib.deflateSync(raw, { level });

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Paeth predictor (PNG filter type 4), as specified.
 * @param {number} a left
 * @param {number} b up
 * @param {number} c upper-left
 * @returns {number} the predicted byte
 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/**
 * Decode an 8-bit greyscale, non-interlaced PNG.
 *
 * Throws with a specific message on any shape this tool does not produce, so
 * an asset that silently became RGB or 16-bit fails loudly in the spec rather
 * than being reinterpreted as garbage greyscale.
 *
 * @param {Buffer} buf the PNG file bytes
 * @returns {{width: number, height: number, pixels: Uint8Array}} decoded image
 */
export function decodeGray8(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("decodeGray8: not a PNG (bad signature)");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  /** @type {Array<Buffer>} */
  const idatParts = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`decodeGray8: truncated chunk ${type}`);
    }
    const data = buf.subarray(dataStart, dataEnd);

    const expected = buf.readUInt32BE(dataEnd);
    const actual = crc32(buf.subarray(offset + 4, dataEnd));
    if (expected !== actual) {
      throw new Error(`decodeGray8: CRC mismatch in chunk ${type}`);
    }

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colourType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8) {
        throw new Error(`decodeGray8: bit depth ${bitDepth}, expected 8`);
      }
      if (colourType !== 0) {
        throw new Error(
          `decodeGray8: colour type ${colourType}, expected 0 (greyscale)`,
        );
      }
      if (interlace !== 0) {
        throw new Error("decodeGray8: interlaced PNGs are not supported");
      }
      sawIhdr = true;
    } else if (type === "IDAT") {
      idatParts.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (!sawIhdr) {
    throw new Error("decodeGray8: no IHDR chunk");
  }
  if (idatParts.length === 0) {
    throw new Error("decodeGray8: no IDAT chunk");
  }

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width + 1;
  if (raw.length !== height * stride) {
    throw new Error(
      `decodeGray8: inflated ${raw.length} bytes, expected ${height * stride}`,
    );
  }

  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const src = y * stride + 1;
    const dst = y * width;
    const up = dst - width;
    for (let x = 0; x < width; x++) {
      const rawByte = raw[src + x];
      const a = x > 0 ? pixels[dst + x - 1] : 0;
      const b = y > 0 ? pixels[up + x] : 0;
      const c = x > 0 && y > 0 ? pixels[up + x - 1] : 0;
      let value;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`decodeGray8: unknown filter type ${filter}`);
      }
      pixels[dst + x] = value & 0xff;
    }
  }

  return { width, height, pixels };
}
