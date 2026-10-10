// globe-metrics-inputs.mjs — deterministic synthetic frames for the globe metric extraction spec.
// @purpose Seeded, integer-only generators of the synthetic RGBA frames metrics-globe-extraction.spec.mjs (and the golden it compares against) runs the globe metrics over: a two-backend globe-disc pair, spread-channel diff pairs, a clipped-hole frame, imagery and flat frames, a green-wash pair, a clip on/off/restore set and a two-tone gray frame.
// @status ACTIVE
//
// WHY SYNTHETIC. The golden `globe-metrics.golden.json` was produced by running
// the ORIGINAL in-page source of each globe probe (sliced verbatim from the
// probes at 7e12d8f1d0) over exactly these frames. A frame decoded from a
// banked PNG would tie the spec to a file under the gitignored output folder;
// a generator ties it to this file, and every value it produces is an integer
// from a seeded mulberry32 stream, so the frames are the same on every machine.
//
// The scenes are shaped to put pixels in every branch the metrics have: a disc
// on black with stars, an ice cap, land and ocean, a limb ring, a thin dark
// seam over land, a brighter interior blob, and a vertically shifted ice cap on
// the second frame of the pair. They are not renders and claim nothing about
// either backend.

/** Seeded 32-bit PRNG (mulberry32), returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blank(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

function clone(image) {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}

function put(image, x, y, r, g, b) {
  const i = 4 * (y * image.width + x);
  image.data[i] = r;
  image.data[i + 1] = g;
  image.data[i + 2] = b;
  image.data[i + 3] = 255;
}

function jitter(rand, amplitude) {
  return Math.floor(rand() * (2 * amplitude + 1)) - amplitude;
}

/**
 * A WebGL-like / WebGPU-like globe-disc pair at 1280x720 (the size the
 * polar-stretch crop constants were written for).
 *
 * @param {{seed?: number}} [options]
 * @returns {{first: object, second: object}}
 */
export function globeDiscPair({ seed = 11 } = {}) {
  const width = 1280;
  const height = 720;
  const cx = 640;
  const cy = 345;
  const R = 280;
  const rand = mulberry32(seed);
  const first = blank(width, height);
  for (let s = 0; s < 500; s++) {
    const x = Math.floor(rand() * width);
    const y = Math.floor(rand() * height);
    const v = 170 + Math.floor(rand() * 86);
    put(first, x, y, v, v, v);
  }
  for (let y = cy - R - 2; y <= cy + R + 2; y++) {
    for (let x = cx - R - 2; x <= cx + R + 2; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const rr = Math.sqrt(dx * dx + dy * dy) / R;
      if (rr > 1.0) continue;
      const v = dy / R;
      let c;
      if (rr > 0.94) {
        const k = Math.floor((1.0 - rr) * 1500);
        c = [60 + k, 110 + k, 200];
      } else if (v < -0.72) {
        c = [
          224 + jitter(rand, 6),
          228 + jitter(rand, 6),
          232 + jitter(rand, 6),
        ];
      } else if ((x * 7 + y * 13) % 97 < 42) {
        c = [
          140 + jitter(rand, 10),
          110 + jitter(rand, 10),
          70 + jitter(rand, 8),
        ];
      } else {
        c = [
          20 + jitter(rand, 5),
          50 + jitter(rand, 6),
          120 + jitter(rand, 10),
        ];
      }
      put(first, x, y, c[0], c[1], c[2]);
    }
  }
  const second = clone(first);
  // The second frame's ice cap sits three rows lower.
  for (let y = cy - R; y < cy - Math.floor(0.6 * R); y++) {
    for (let x = cx - R; x <= cx + R; x++) {
      const src = 4 * ((y - 3) * width + x);
      const dst = 4 * (y * width + x);
      for (let k = 0; k < 3; k++) second.data[dst + k] = first.data[src + k];
    }
  }
  // A brighter interior blob.
  for (let y = 300; y < 340; y++) {
    for (let x = 560; x < 620; x++) {
      const i = 4 * (y * width + x);
      for (let k = 0; k < 3; k++) second.data[i + k] = first.data[i + k] + 25;
    }
  }
  // A darker interior blob.
  for (let y = 400; y < 430; y++) {
    for (let x = 700; x < 760; x++) {
      const i = 4 * (y * width + x);
      for (let k = 0; k < 3; k++) second.data[i + k] = first.data[i + k] - 30;
    }
  }
  // One-pixel dark-navy seam lines through the interior.
  for (let y = cy - 150; y <= cy + 150; y++) put(second, 680, y, 5, 5, 70);
  for (let x = cx - 150; x <= cx + 150; x++) put(second, x, 460, 5, 5, 70);
  // A brighter limb arc and some moved stars.
  for (let y = cy - R; y <= cy; y++) {
    for (let x = cx; x <= cx + R; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const rr = Math.sqrt(dx * dx + dy * dy) / R;
      if (rr > 0.94 && rr <= 1.0) {
        const i = 4 * (y * width + x);
        for (let k = 0; k < 3; k++) second.data[i + k] = first.data[i + k] + 40;
      }
    }
  }
  // Stars that exist only in the second frame, inside the crop but outside the
  // disc, so the space bucket is populated.
  for (let s = 0; s < 60; s++) {
    const x = 255 + Math.floor(rand() * 90);
    const y = 60 + Math.floor(rand() * 560);
    put(second, x, y, 250, 250, 250);
  }
  return { first, second };
}

/**
 * Two noisy frames whose second copy moves ~35 % of pixels by a delta spread
 * over the channels (so the channel SUM, not the channel maximum, crosses 30).
 *
 * @param {{width?: number, height?: number, seed?: number}} [options]
 * @returns {{first: object, second: object}}
 */
export function spreadDiffPair({ width = 320, height = 200, seed = 21 } = {}) {
  const rand = mulberry32(seed);
  const first = blank(width, height);
  for (let p = 0; p < width * height; p++) {
    const i = 4 * p;
    first.data[i] = Math.floor(rand() * 200) + 20;
    first.data[i + 1] = Math.floor(rand() * 200) + 20;
    first.data[i + 2] = Math.floor(rand() * 200) + 20;
  }
  const second = clone(first);
  for (let p = 0; p < width * height; p++) {
    const roll = rand();
    const i = 4 * p;
    if (roll < 0.2) {
      second.data[i] += 12;
      second.data[i + 1] += 12;
      second.data[i + 2] += 12;
    } else if (roll < 0.35) {
      second.data[i] -= 40;
      second.data[i + 2] += 5;
    } else if (roll < 0.5) {
      second.data[i + 1] += 9;
    }
  }
  return { first, second };
}

/**
 * A sand-coloured globe frame with a black hole at the centre, and the same
 * frame without the hole.
 *
 * @param {{width?: number, height?: number, holeRadius?: number}} [options]
 * @returns {{holed: object, solid: object}}
 */
export function clippedHoleFrames({
  width = 800,
  height = 600,
  holeRadius = 70,
} = {}) {
  const solid = blank(width, height);
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= 260 * 260;
      if (inside) put(solid, x, y, 244, 164, 96);
    }
  }
  const holed = clone(solid);
  for (let y = cy - holeRadius; y <= cy + holeRadius; y++) {
    for (let x = cx - holeRadius; x <= cx + holeRadius; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= holeRadius * holeRadius) {
        put(holed, x, y, (x + y) % 17, 0, (x * y) % 11);
      }
    }
  }
  return { holed, solid };
}

/**
 * A colourful noisy frame with a black border, and a flat single-colour frame.
 *
 * @param {{width?: number, height?: number, seed?: number}} [options]
 * @returns {{imagery: object, flat: object}}
 */
export function imageryAndFlatFrames({
  width = 256,
  height = 192,
  seed = 31,
} = {}) {
  const rand = mulberry32(seed);
  const imagery = blank(width, height);
  const flat = blank(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      put(flat, x, y, 40, 60, 90);
      if (x < 20 || y < 12) continue;
      put(
        imagery,
        x,
        y,
        Math.floor(rand() * 256),
        Math.floor(rand() * 256),
        Math.floor(rand() * 256),
      );
    }
  }
  return { imagery, flat };
}

/**
 * A lit frame and the same frame with a green wash over its right half.
 *
 * @param {{width?: number, height?: number, seed?: number}} [options]
 * @returns {{before: object, after: object}}
 */
export function greenWashPair({ width = 256, height = 192, seed = 41 } = {}) {
  const rand = mulberry32(seed);
  const before = blank(width, height);
  for (let p = 0; p < width * height; p++) {
    const i = 4 * p;
    const dark = rand() < 0.1;
    before.data[i] = dark ? 5 : 30 + Math.floor(rand() * 180);
    before.data[i + 1] = dark ? 5 : 30 + Math.floor(rand() * 180);
    before.data[i + 2] = dark ? 5 : 30 + Math.floor(rand() * 180);
  }
  const after = clone(before);
  for (let y = 0; y < height; y++) {
    for (let x = Math.floor(width / 2); x < width; x++) {
      const i = 4 * (y * width + x);
      // The bottom quarter's wash crosses the changed-pixel tolerance of 24.
      const strong = y >= Math.floor((3 * height) / 4);
      after.data[i] -= 7;
      after.data[i + 1] += strong ? 30 : 21;
      after.data[i + 2] -= 3;
    }
  }
  return { before, after };
}

/**
 * The four frames of an effect toggle: baseline, effect on (a carved region),
 * effect off (baseline plus small noise), effect restored (on plus small noise).
 *
 * @param {{width?: number, height?: number, seed?: number}} [options]
 * @returns {{baseline: object, on: object, off: object, restore: object}}
 */
export function toggleFrames({ width = 256, height = 192, seed = 51 } = {}) {
  const rand = mulberry32(seed);
  const baseline = blank(width, height);
  for (let p = 0; p < width * height; p++) {
    const i = 4 * p;
    baseline.data[i] = 60 + Math.floor(rand() * 120);
    baseline.data[i + 1] = 80 + Math.floor(rand() * 100);
    baseline.data[i + 2] = 40 + Math.floor(rand() * 90);
  }
  const on = clone(baseline);
  for (let y = 20; y < 150; y++) {
    for (let x = 128; x < 250; x++) put(on, x, y, 0, 0, 0);
  }
  const noisy = (image) => {
    const out = clone(image);
    for (let p = 0; p < width * height; p++) {
      if (rand() < 0.03) {
        const i = 4 * p;
        out.data[i] += 20;
      }
    }
    return out;
  };
  return { baseline, on, off: noisy(baseline), restore: noisy(on) };
}

/**
 * A 1024x768 two-tone gray frame (west 100, east 180, with a soft seam and a
 * little noise) and the same frame with each gray decoded from sRGB once.
 *
 * @param {{seed?: number}} [options]
 * @returns {{sdr: object, hdr: object}}
 */
export function twoToneGrayFrames({ seed = 61 } = {}) {
  const width = 1024;
  const height = 768;
  const rand = mulberry32(seed);
  const sdr = blank(width, height);
  const hdr = blank(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = Math.min(1, Math.max(0, (x - 448) / 128));
      const base = Math.round(100 + 80 * t) + jitter(rand, 2);
      put(sdr, x, y, base, base, base);
      const decoded = Math.round(255 * Math.pow(base / 255, 2.2));
      put(hdr, x, y, decoded, decoded, decoded);
    }
  }
  return { sdr, hdr };
}
