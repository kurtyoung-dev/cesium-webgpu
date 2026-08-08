// image-anchors.mjs — CONTENT anchors for a captured screenshot, decided in
// Node from the PNG bytes. Pure: no browser, no network, no GPU.
//
// WHY A PIXEL PERCENTAGE IS NOT EVIDENCE THAT THE SUBJECT IS IN FRAME. The
// capture script's thresholds ask "how much of this image is not black" and
// "how many colours does it hold". Both were satisfied, for a whole run, by
// pixels that had nothing to do with the scene: the viewer's own DOM chrome —
// navigation help, timeline, credits — sits ON TOP of the canvas and is
// included in an element screenshot, and it alone covers ~18 % of the frame in
// more than eight distinct colours. A celestial capture whose sky was entirely
// black therefore PASSED its 0.5 % floor, and the run reported it captured.
//
// The anchors below ask a different question, one the chrome cannot answer for
// the scene: is the SUBJECT there. `brightSpot` requires a connected region of
// bright pixels — a sun or moon disc is exactly that, and a black sky is not,
// no matter how bright the surrounding UI. `horizonCoverage` requires content
// to be spread down the frame — it fails the "top half is a vista, bottom half
// is void" composition that a global percentage happily passes.
//
// A failed anchor is STRUCTURAL, not a pixel miss: the run could not see its
// subject, which is a different fact from "the subject was too dark".
//
// WHY THE DECODER IS HERE AND NOT A DEPENDENCY. The probe fleet takes no
// external packages, and the alternative — asking the page to measure itself —
// is the trap this repo already paid for: reading a WebGPU canvas back in-page
// yields transparent pixels. These functions read a FILE that Playwright has
// already written, in Node, where `node --test` can check them against images
// it builds byte by byte.

import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Channel count per PNG colour type; 0 marks a type this decoder rejects. */
const CHANNELS_BY_COLOR_TYPE = Object.freeze({
  0: 1, // greyscale
  2: 3, // truecolour
  4: 2, // greyscale + alpha
  6: 4, // truecolour + alpha
});

/**
 * Paeth predictor, verbatim from the PNG specification.
 *
 * @param {number} a Left byte.
 * @param {number} b Above byte.
 * @param {number} c Upper-left byte.
 * @returns {number} The predicted byte.
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
 * Decode an 8-bit, non-interlaced PNG into RGB samples.
 *
 * Every scanline filter is reconstructed. An "approximate" decoder that skips
 * filter bytes reads plausible-looking garbage for filters 1-4, which is worse
 * than failing: the anchors would then be measuring an image nobody produced.
 *
 * @param {Buffer|Uint8Array} bytes PNG file contents.
 * @returns {{width: number, height: number, rgb: Uint8Array}} Decoded image;
 *   `rgb` holds three bytes per pixel in row-major order.
 */
export function decodePng(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) {
      throw new Error("not a PNG: signature mismatch");
    }
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length + type + data + CRC
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth}; expected 8`);
  }
  if (interlace !== 0) {
    throw new Error("unsupported interlaced PNG");
  }
  const channels = CHANNELS_BY_COLOR_TYPE[colorType] ?? 0;
  if (channels === 0) {
    throw new Error(`unsupported PNG colour type ${colorType}`);
  }
  if (width <= 0 || height <= 0) {
    throw new Error("PNG declares no pixels");
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) {
    throw new Error(
      `PNG data is short: ${raw.length} bytes for ${height} rows of ${stride}`,
    );
  }

  const out = new Uint8Array(width * height * 3);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    for (let i = 0; i < stride; i++) {
      const x = raw[read + i];
      const a = i >= channels ? current[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let value;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      current[i] = value & 0xff;
    }
    read += stride;
    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = (y * width + x) * 3;
      if (channels >= 3) {
        out[dst] = current[src];
        out[dst + 1] = current[src + 1];
        out[dst + 2] = current[src + 2];
      } else {
        out[dst] = current[src];
        out[dst + 1] = current[src];
        out[dst + 2] = current[src];
      }
    }
    previous.set(current);
  }

  return { width, height, rgb: out };
}

/** Rec. 709 luma, the convention the celestial probes measure brightness in. */
export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Largest 4-connected region of pixels at or above a luminance threshold.
 *
 * A sun or moon disc is one such region. Scattered stars, sensor-like noise and
 * a bright UI panel that has been cropped away are not — which is the point:
 * the measure is deliberately insensitive to a total count of bright pixels.
 *
 * @param {{width: number, height: number, rgb: Uint8Array}} image Decoded image.
 * @param {number} threshold Luminance at or above which a pixel is "bright".
 * @returns {{pixels: number, centerX: number, centerY: number, brightTotal: number}}
 *   The largest region's size and centroid, plus the total bright-pixel count.
 */
export function largestBrightRegion(image, threshold) {
  const { width, height, rgb } = image;
  const total = width * height;
  const bright = new Uint8Array(total);
  let brightTotal = 0;
  for (let p = 0; p < total; p++) {
    const i = p * 3;
    if (luminance(rgb[i], rgb[i + 1], rgb[i + 2]) >= threshold) {
      bright[p] = 1;
      brightTotal++;
    }
  }

  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  let best = { pixels: 0, centerX: 0, centerY: 0 };
  for (let start = 0; start < total; start++) {
    if (bright[start] === 0 || seen[start] === 1) {
      continue;
    }
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let pixels = 0;
    let sumX = 0;
    let sumY = 0;
    while (top > 0) {
      const p = stack[--top];
      const x = p % width;
      const y = (p - x) / width;
      pixels++;
      sumX += x;
      sumY += y;
      if (x > 0 && bright[p - 1] === 1 && seen[p - 1] === 0) {
        seen[p - 1] = 1;
        stack[top++] = p - 1;
      }
      if (x + 1 < width && bright[p + 1] === 1 && seen[p + 1] === 0) {
        seen[p + 1] = 1;
        stack[top++] = p + 1;
      }
      if (y > 0 && bright[p - width] === 1 && seen[p - width] === 0) {
        seen[p - width] = 1;
        stack[top++] = p - width;
      }
      if (y + 1 < height && bright[p + width] === 1 && seen[p + width] === 0) {
        seen[p + width] = 1;
        stack[top++] = p + width;
      }
    }
    if (pixels > best.pixels) {
      best = {
        pixels,
        centerX: sumX / pixels,
        centerY: sumY / pixels,
      };
    }
  }
  return { ...best, brightTotal };
}

/**
 * Fraction of image rows carrying at least `minRowPixels` non-black pixels.
 *
 * The composition this rejects is the one a global percentage cannot see: a
 * vista across the top of the frame and void across the bottom scores the same
 * "45 % non-black" as a subject that fills the picture evenly.
 *
 * @param {{width: number, height: number, rgb: Uint8Array}} image Decoded image.
 * @param {number} minRowPixels Non-black pixels a row needs to count as covered.
 * @param {number} blackLevel Channel value at or below which a pixel is black.
 * @returns {{coveredRows: number, rows: number, fraction: number}} Coverage.
 */
export function rowCoverage(image, minRowPixels, blackLevel) {
  const { width, height, rgb } = image;
  let coveredRows = 0;
  for (let y = 0; y < height; y++) {
    let count = 0;
    const rowStart = y * width * 3;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 3;
      if (
        rgb[i] > blackLevel ||
        rgb[i + 1] > blackLevel ||
        rgb[i + 2] > blackLevel
      ) {
        count++;
        if (count >= minRowPixels) {
          break;
        }
      }
    }
    if (count >= minRowPixels) {
      coveredRows++;
    }
  }
  return {
    coveredRows,
    rows: height,
    fraction: height === 0 ? 0 : coveredRows / height,
  };
}

/** Defaults for each anchor, so a manifest states only what it means to change. */
export const ANCHOR_DEFAULTS = Object.freeze({
  brightSpot: { luminance: 170, minPixels: 150 },
  horizonCoverage: { minRowFraction: 0.9, minRowPixels: 8, blackLevel: 16 },
});

/** Anchor names `evaluateAnchors` implements; the manifest is validated against it. */
export const ANCHOR_KINDS = Object.freeze(Object.keys(ANCHOR_DEFAULTS));

/**
 * Evaluate a scene's declared anchors against its captured PNG.
 *
 * @param {Buffer|Uint8Array} pngBytes The PNG the capture just wrote.
 * @param {object} [anchor] The scene's `anchor` block; absent means no anchors.
 * @returns {{failures: string[], measured: object}} Failures (empty when the
 *   image satisfies every declared anchor) and the numbers behind them.
 */
export function evaluateAnchors(pngBytes, anchor) {
  const measured = {};
  const failures = [];
  if (anchor === undefined || anchor === null) {
    return { failures, measured };
  }
  let image;
  try {
    image = decodePng(pngBytes);
  } catch (error) {
    return {
      failures: [
        `anchor: the captured PNG could not be decoded (${String(error.message ?? error)})`,
      ],
      measured,
    };
  }

  if (anchor.brightSpot !== undefined) {
    const spec = { ...ANCHOR_DEFAULTS.brightSpot, ...anchor.brightSpot };
    const region = largestBrightRegion(image, spec.luminance);
    measured.brightSpot = {
      largestRegionPixels: region.pixels,
      brightPixels: region.brightTotal,
      centerX: Number(region.centerX.toFixed(1)),
      centerY: Number(region.centerY.toFixed(1)),
      required: spec,
    };
    if (region.pixels < spec.minPixels) {
      failures.push(
        `anchor brightSpot: the largest region above luminance ${spec.luminance} is ${region.pixels} px, below the ${spec.minPixels} px this scene's subject must cover — the subject is not in frame`,
      );
    }
  }

  if (anchor.horizonCoverage !== undefined) {
    const spec = {
      ...ANCHOR_DEFAULTS.horizonCoverage,
      ...anchor.horizonCoverage,
    };
    const coverage = rowCoverage(image, spec.minRowPixels, spec.blackLevel);
    measured.horizonCoverage = {
      coveredRows: coverage.coveredRows,
      rows: coverage.rows,
      fraction: Number(coverage.fraction.toFixed(4)),
      required: spec,
    };
    if (coverage.fraction < spec.minRowFraction) {
      failures.push(
        `anchor horizonCoverage: only ${coverage.coveredRows}/${coverage.rows} rows (${(coverage.fraction * 100).toFixed(1)} %) carry content, below the ${(spec.minRowFraction * 100).toFixed(0)} % this scene's composition requires — part of the frame is void`,
      );
    }
  }

  return { failures, measured };
}
