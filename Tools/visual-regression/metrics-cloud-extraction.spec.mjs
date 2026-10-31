// @purpose Pins that moving the cloud metrics into lib/metrics changed no number: it runs each
//   moved function's live body over the fixtures the pre-move body was captured on and requires
//   exact equality, that the three cloud modules still export every name they did, and that exactly
//   one implementation of each moved name exists.
// @status ACTIVE
//
// WHY THE "BEFORE" SIDE IS A CHECKED-IN GOLDEN FIXTURE. A reference
// implementation transcribed into a spec proves the transcription matches, not
// that the move did. So the before side is what the real pre-move modules
// actually RETURNED: `fixtures/metrics-cloud-extraction.golden.json` was
// captured on 2026-09-18 by running every case below against the three cloud
// modules as they stood at commit 1a2baeaa4abd96b8d1c33dcdc14f37b7eddd174f,
// immediately before the extraction. **Regenerate it only when a banked number
// is deliberately changed** — a regeneration that accompanies a refactor is the
// spec being edited to agree with the code it exists to check. The three cases
// that reach Math.sin / Math.cos were recaptured on 2026-10-30 from the same
// pre-move modules under the pinned trigonometry described below; that changed
// the fixture, not the code under test.
//
// WHY NOT READ THE OLD SOURCE FROM GIT. The first draft of this spec read each
// module out of `HEAD` and imported it as a data: URL. `HEAD` moves: the moment
// this extraction lands, `HEAD:` returns the delegating barrel, whose relative
// `./metrics/*.mjs` specifiers cannot resolve from a data: URL, and the spec
// stops loading at all. Pinning the hash fixes that but makes the spec need the
// commit to be reachable, so it breaks in every shallow clone and every
// depth-limited checkout. A checked-in fixture needs neither git nor history.
//
// EXACTNESS IS THE POINT. `deepStrictEqual` compares floats bit-for-bit, so a
// reordered accumulation or a widened default fails here even when it would
// pass a tolerance-based check. That is the bar this extraction was held to,
// and the codec below is what carries it through JSON without losing a bit.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MODULES = [
  "cloud-photometry.mjs",
  "cloud-spectrum.mjs",
  "cloud-orbital-ladder-model.mjs",
];

const after = {};
for (const fileName of MODULES) {
  after[fileName] = await import(`./lib/${fileName}`);
}

const metrics = {
  masks: await import("./lib/metrics/masks.mjs"),
  luminance: await import("./lib/metrics/luminance.mjs"),
  saturation: await import("./lib/metrics/saturation.mjs"),
  spectralSlope: await import("./lib/metrics/spectral-slope.mjs"),
  regionMeans: await import("./lib/metrics/region-means.mjs"),
};

// ── the exact-value codec ───────────────────────────────────────────────────
//
// JSON cannot hold a JavaScript double faithfully: `-0` serialises as `0`, and
// `NaN` / `±Infinity` become `null`. Every number is therefore written as a
// STRING produced by `Number.prototype.toString()`, which ECMA-262 defines as
// the shortest decimal that reads back as the same double — so `Number(s)`
// reproduces the original bit pattern exactly — with explicit tokens for the
// four values that have no round-trippable decimal form. Typed arrays keep their
// constructor name and carry their raw bytes as base64, which is bit-exact and
// far smaller than a per-element encoding.

/** Tokens for the doubles a decimal string cannot round-trip. */
const NEGATIVE_ZERO = "-0";
const TYPED_ARRAYS = Object.freeze({
  Uint8Array,
  Uint8ClampedArray,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
});

/** A value as it is stored in the golden fixture. Lossless for every double. */
function encodeExact(value) {
  if (typeof value === "number") {
    if (Object.is(value, -0)) {
      return { $n: NEGATIVE_ZERO };
    }
    return { $n: value.toString() };
  }
  if (value === undefined) {
    return { $undefined: true };
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const ctorName = value.constructor?.name;
  if (Object.hasOwn(TYPED_ARRAYS, ctorName)) {
    return {
      $typed: ctorName,
      bytes: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).toString("base64"),
    };
  }
  if (Array.isArray(value)) {
    return value.map(encodeExact);
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = encodeExact(value[key]);
  }
  return out;
}

/** The inverse of `encodeExact`. */
function decodeExact(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeExact);
  }
  if (Object.hasOwn(value, "$n")) {
    return value.$n === NEGATIVE_ZERO ? -0 : Number(value.$n);
  }
  if (Object.hasOwn(value, "$undefined")) {
    return undefined;
  }
  if (Object.hasOwn(value, "$typed")) {
    const Ctor = TYPED_ARRAYS[value.$typed];
    const bytes = Buffer.from(value.bytes, "base64");
    return new Ctor(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = decodeExact(value[key]);
  }
  return out;
}

/** The pre-move outputs, captured once and checked in. */
const GOLDEN = JSON.parse(
  readFileSync(
    path.join(HERE, "fixtures", "metrics-cloud-extraction.golden.json"),
    "utf8",
  ),
);

// ── fixtures ────────────────────────────────────────────────────────────────

/** mulberry32, so every fixture below is the same on every machine and run. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticRgba(width, height, seed) {
  const rng = seededRandom(seed);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = Math.floor(rng() * 256);
    rgba[i * 4 + 1] = Math.floor(rng() * 256);
    rgba[i * 4 + 2] = Math.floor(rng() * 256);
    rgba[i * 4 + 3] = Math.floor(rng() * 256);
  }
  return rgba;
}

function uniformRgba(width, height, value) {
  return new Uint8Array(width * height * 4).fill(value);
}

function zeroRgba(width, height) {
  return new Uint8Array(width * height * 4);
}

function scalarField(width, height, seed) {
  const rng = seededRandom(seed);
  const field = new Float64Array(width * height);
  for (let i = 0; i < field.length; i++) {
    field[i] = rng();
  }
  return field;
}

// ── pinned trigonometry ─────────────────────────────────────────────────────
//
// ECMA-262 leaves Math.sin and Math.cos implementation-approximated, and V8 has
// changed them between releases: over the 1,438 angles the 24x24 fBm path
// evaluates, V8 13.6 (Node 24.22.1) and V8 15.0 disagree by one ulp on 37
// cosines and 50 sines. The separable DFT spreads that into hundreds of
// near-zero field values, so the fBm, spectrum and slope-fit cases failed
// bit-for-bit against a fixture captured on another runtime while the moved
// code was unchanged. This spec checks the moved code, not the engine's libm,
// so every case runs with the two functions swapped for the pair below. It uses
// only IEEE-754 +, -, *, / and Math.round, which are exactly specified, so it
// returns the same double on every conforming engine: fdlibm's 33-bit
// Cody-Waite reduction by pi/2 and its __kernel_sin / __kernel_cos minimax
// polynomials. The angles here stay far below the 2^20 * pi/2 range where the
// two-part reduction is exact.

const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_HI = 1.57079632673412561417;
const PIO2_LO = 6.07710050650619224932e-11;
const SIN_POLY = [
  -1.66666666666666324348e-1, 8.33333333332248946124e-3,
  -1.98412698298579493134e-4, 2.75573137070700676789e-6,
  -2.50507602534068634195e-8, 1.58969099521155010221e-10,
];
const COS_POLY = [
  4.16666666666666019037e-2, -1.38888888888741095749e-3,
  2.48015872894767294178e-5, -2.75573143513906633035e-7,
  2.0875723212981748279e-9, -1.13596475577881948265e-11,
];

function kernelSin(x) {
  const [s1, s2, s3, s4, s5, s6] = SIN_POLY;
  const z = x * x;
  const r = s2 + z * (s3 + z * (s4 + z * (s5 + z * s6)));
  return x + z * x * (s1 + z * r);
}

function kernelCos(x) {
  const [c1, c2, c3, c4, c5, c6] = COS_POLY;
  const z = x * x;
  const r = z * (c1 + z * (c2 + z * (c3 + z * (c4 + z * (c5 + z * c6)))));
  return 1 - (0.5 * z - z * r);
}

/** x reduced to [-pi/4, pi/4] and the quadrant it was reduced from. */
function reduceQuarterTurn(x) {
  const n = Math.round(x * INV_PIO2);
  return { r: x - n * PIO2_HI - n * PIO2_LO, quadrant: ((n % 4) + 4) % 4 };
}

function pinnedSin(x) {
  if (x === 0) {
    return x;
  }
  const { r, quadrant } = reduceQuarterTurn(x);
  const value = quadrant % 2 === 0 ? kernelSin(r) : kernelCos(r);
  return quadrant < 2 ? value : -value;
}

function pinnedCos(x) {
  const { r, quadrant } = reduceQuarterTurn(x);
  const value = quadrant % 2 === 0 ? kernelCos(r) : kernelSin(r);
  return quadrant === 0 || quadrant === 3 ? value : -value;
}

/** Runs `body` with Math.sin / Math.cos pinned, restoring the engine's pair after. */
function withPinnedTrig(body) {
  const { sin, cos } = Math;
  Math.sin = pinnedSin;
  Math.cos = pinnedCos;
  try {
    return body();
  } finally {
    Math.sin = sin;
    Math.cos = cos;
  }
}

const W = 24;
const H = 16;
const RGBA_SYNTHETIC = syntheticRgba(W, H, 20260918);
const RGBA_UNIFORM = uniformRgba(W, H, 128);
const RGBA_ZERO = zeroRgba(W, H);
const RGBA_SATURATED = uniformRgba(W, H, 255);
const EMPTY_MASK = new Uint8Array(W * H); // selects nothing
const ALL_MASK = new Uint8Array(W * H).fill(1);

/** Runs `fn` and captures either its value or the exact error it threw. */
function outcome(fn) {
  try {
    return { value: fn(), threw: null };
  } catch (error) {
    return { value: undefined, threw: `${error.name}: ${error.message}` };
  }
}

/**
 * One row of the before/after comparison.
 *
 * `call` receives a namespace-like object and must reach the function through
 * it, so the identical closure drives the pre-move module and the live one.
 */
const CASES = [
  // ── masks.mjs ─────────────────────────────────────────────────────────────
  {
    name: "circularMask/typical",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.circularMask({
        width: W,
        height: H,
        centreX: 11.5,
        centreY: 7.5,
        radiusPixels: 4.25,
      }),
    report: (v) => v.count,
  },
  {
    name: "circularMask/zero-radius-empty-mask",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.circularMask({
        width: W,
        height: H,
        centreX: 0,
        centreY: 0,
        radiusPixels: 0,
      }),
    report: (v) => v.count,
  },
  {
    name: "circularMask/negative-radius-refused",
    module: "cloud-photometry.mjs",
    call: (m) =>
      outcome(() =>
        m.circularMask({
          width: W,
          height: H,
          centreX: 1,
          centreY: 1,
          radiusPixels: -1,
        }),
      ),
    report: (v) => v.threw,
  },
  {
    name: "rectRoi/default-is-whole-image",
    module: "cloud-photometry.mjs",
    call: (m) => m.rectRoi({ width: W, height: H }),
    report: (v) => `${v.x0},${v.y0},${v.x1},${v.y1}`,
  },
  {
    name: "rectRoi/clamped-out-of-bounds",
    module: "cloud-photometry.mjs",
    call: (m) => m.rectRoi({ width: W, height: H, x: -5, y: 9, w: 999, h: 3 }),
    report: (v) => `${v.x0},${v.y0},${v.x1},${v.y1}`,
  },

  // ── luminance.mjs ─────────────────────────────────────────────────────────
  {
    name: "luminance/rec709",
    module: "cloud-photometry.mjs",
    call: (m) => [
      m.luminance(0.25, 0.5, 0.75),
      m.luminance(0, 0, 0),
      m.luminance(1, 1, 1),
    ],
    report: (v) => v[0],
  },
  {
    name: "forwardReinhard/curve",
    module: "cloud-photometry.mjs",
    call: (m) => [
      m.forwardReinhard(3.7, 0.22),
      m.forwardReinhard(0, 0.22),
      m.forwardReinhard(1e6, 0.22),
    ],
    report: (v) => v[0],
  },
  {
    name: "inverseReinhard/round-trip",
    module: "cloud-photometry.mjs",
    call: (m) => [
      m.inverseReinhard(m.forwardReinhard(3.7, 0.22), 0.22),
      m.inverseReinhard(0, 0.22),
    ],
    report: (v) => v[0],
  },
  {
    name: "inverseReinhard/saturation-refused",
    module: "cloud-photometry.mjs",
    call: (m) => outcome(() => m.inverseReinhard(1, 0.22)),
    report: (v) => v.threw,
  },
  {
    name: "displaySpaceLuminanceMean/synthetic",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.displaySpaceLuminanceMean(RGBA_SYNTHETIC, { width: W, height: H }),
    report: (v) => v,
  },
  {
    name: "displaySpaceLuminanceMean/srgb-transfer",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.displaySpaceLuminanceMean(RGBA_SYNTHETIC, {
        width: W,
        height: H,
        transfer: "srgb",
      }),
    report: (v) => v,
  },
  {
    name: "displaySpaceLuminanceMean/zero-population-is-null",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.displaySpaceLuminanceMean(RGBA_SYNTHETIC, {
        width: W,
        height: H,
        roi: { x0: 3, y0: 3, x1: 3, y1: 9 },
      }),
    report: (v) => v,
  },
  {
    name: "pins/constants",
    module: "cloud-photometry.mjs",
    call: (m) => ({
      pin: m.REINHARD_OPERATOR_PIN,
      slot: m.EXPOSURE_UNIFORM_SLOT,
      exposure: m.DEFAULT_CLOUD_EXPOSURE,
      ceiling: m.DEFAULT_SATURATION_CEILING,
      transfer: m.DEFAULT_TRANSFER,
      transferKeys: Object.keys(m.TRANSFER_FUNCTIONS),
      srgbAt: m.TRANSFER_FUNCTIONS.srgb(0.5),
      identityAt: m.TRANSFER_FUNCTIONS.identity(0.5),
    }),
    report: (v) => `${v.slot}/${v.ceiling}`,
  },

  // ── saturation.mjs ────────────────────────────────────────────────────────
  {
    name: "photometricStats/synthetic",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.photometricStats(RGBA_SYNTHETIC, {
        width: W,
        height: H,
        exposure: 0.22,
      }),
    report: (v) => v.meanLuminance,
  },
  {
    name: "photometricStats/uniform",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.photometricStats(RGBA_UNIFORM, { width: W, height: H, exposure: 0.22 }),
    report: (v) => v.meanLuminance,
  },
  {
    name: "photometricStats/all-zero",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.photometricStats(RGBA_ZERO, { width: W, height: H, exposure: 0.22 }),
    report: (v) => v.meanLuminance,
  },
  {
    name: "photometricStats/fully-saturated-counts-refusals",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.photometricStats(RGBA_SATURATED, {
        width: W,
        height: H,
        exposure: 0.22,
      }),
    report: (v) => `${v.counted}/${v.saturatedFraction}`,
  },
  {
    name: "photometricStats/sun-disc-mask-excludes-everything",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.photometricStats(RGBA_SYNTHETIC, {
        width: W,
        height: H,
        exposure: 0.22,
        sunDiscMask: { width: W, height: H, data: ALL_MASK, count: W * H },
      }),
    report: (v) => `${v.counted}/${v.meanLuminance}`,
  },
  {
    name: "photometricStats/roi-and-srgb-and-lowered-ceiling",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.photometricStats(RGBA_SYNTHETIC, {
        width: W,
        height: H,
        exposure: 0.31,
        roi: { x0: 2, y0: 1, x1: 20, y1: 14 },
        transfer: "srgb",
        saturationCeiling: 0.9,
        sunDiscMask: { width: W, height: H, data: EMPTY_MASK, count: 0 },
      }),
    report: (v) => v.medianLuminance,
  },
  {
    name: "photometricStats/missing-exposure-refused",
    module: "cloud-photometry.mjs",
    call: (m) =>
      outcome(() =>
        m.photometricStats(RGBA_SYNTHETIC, { width: W, height: H }),
      ),
    report: (v) => v.threw,
  },
  {
    name: "photometricRatio/comparable",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.photometricRatio(
        m.photometricStats(RGBA_SYNTHETIC, {
          width: W,
          height: H,
          exposure: 0.22,
          roi: { x0: 0, y0: 0, x1: 12, y1: H },
        }),
        m.photometricStats(RGBA_SYNTHETIC, {
          width: W,
          height: H,
          exposure: 0.22,
          roi: { x0: 12, y0: 0, x1: W, y1: H },
        }),
      ),
    report: (v) => v.ratio,
  },
  {
    name: "photometricRatio/null-denominator",
    module: "cloud-photometry.mjs",
    call: (m) =>
      m.photometricRatio(
        m.photometricStats(RGBA_SYNTHETIC, {
          width: W,
          height: H,
          exposure: 0.22,
        }),
        m.photometricStats(RGBA_SATURATED, {
          width: W,
          height: H,
          exposure: 0.22,
        }),
      ),
    report: (v) => String(v.ratio),
  },

  // ── spectral-slope.mjs ────────────────────────────────────────────────────
  {
    name: "syntheticFractionalBrownianField/seeded",
    module: "cloud-spectrum.mjs",
    call: (m) =>
      m.syntheticFractionalBrownianField({
        width: 24,
        height: 24,
        slope: -5 / 3,
        seed: 4242,
      }),
    report: (v) => v[0],
  },
  {
    name: "radialPowerSpectrum/fbm",
    module: "cloud-spectrum.mjs",
    call: (m) =>
      m.radialPowerSpectrum(
        m.syntheticFractionalBrownianField({
          width: 24,
          height: 24,
          slope: -5 / 3,
          seed: 4242,
        }),
        { width: 24, height: 24, metresPerPixel: 500 },
      ),
    report: (v) => v.bins[0].power,
  },
  {
    name: "radialPowerSpectrum/constant-field",
    module: "cloud-spectrum.mjs",
    call: (m) =>
      m.radialPowerSpectrum(new Float64Array(16 * 16).fill(0.42), {
        width: 16,
        height: 16,
        metresPerPixel: 250,
      }),
    report: (v) => v.bins[0].power,
  },
  {
    name: "fitSpectralSlope/band",
    module: "cloud-spectrum.mjs",
    call: (m) =>
      m.fitSpectralSlope(
        m.radialPowerSpectrum(
          m.syntheticFractionalBrownianField({
            width: 24,
            height: 24,
            slope: -5 / 3,
            seed: 4242,
          }),
          { width: 24, height: 24, metresPerPixel: 500 },
        ),
        { minWavelengthMetres: 1500, maxWavelengthMetres: 12000 },
      ),
    report: (v) => v.slope,
  },
  {
    name: "fitSpectralSlope/insufficient-band-bins",
    module: "cloud-spectrum.mjs",
    call: (m) =>
      m.fitSpectralSlope(
        m.radialPowerSpectrum(scalarField(16, 16, 7), {
          width: 16,
          height: 16,
          metresPerPixel: 250,
        }),
        { minWavelengthMetres: 1e9, maxWavelengthMetres: 2e9 },
      ),
    report: (v) => v.failures[0],
  },
  {
    name: "areaPerimeterFractalDimension/fbm",
    module: "cloud-spectrum.mjs",
    call: (m) =>
      m.areaPerimeterFractalDimension(scalarField(40, 40, 99), {
        width: 40,
        height: 40,
        thresholds: [0.4, 0.5, 0.6],
        minimumAreaPixels: 4,
        minimumBlobCount: 1,
      }),
    report: (v) => v.dimension,
  },
  {
    name: "areaPerimeterFractalDimension/insufficient-blobs",
    module: "cloud-spectrum.mjs",
    call: (m) =>
      m.areaPerimeterFractalDimension(new Float64Array(16 * 16), {
        width: 16,
        height: 16,
        thresholds: [0.5],
      }),
    report: (v) => v.failures[0],
  },

  // ── region-means.mjs ──────────────────────────────────────────────────────
  {
    name: "meanCloudAlpha/no-mask",
    module: "cloud-orbital-ladder-model.mjs",
    call: (m) => m.meanCloudAlpha(RGBA_SYNTHETIC, { width: W, height: H }),
    report: (v) => v.meanAlpha,
  },
  {
    name: "meanCloudAlpha/all-zero",
    module: "cloud-orbital-ladder-model.mjs",
    call: (m) => m.meanCloudAlpha(RGBA_ZERO, { width: W, height: H }),
    report: (v) => v.meanAlpha,
  },
  {
    name: "meanCloudAlpha/empty-mask-zero-population",
    module: "cloud-orbital-ladder-model.mjs",
    call: (m) =>
      m.meanCloudAlpha(RGBA_SYNTHETIC, {
        width: W,
        height: H,
        cloudMask: EMPTY_MASK,
      }),
    report: (v) => `${v.meanAlpha}/${v.coverageFraction}`,
  },
  {
    name: "imageAerialCapFraction/synthetic",
    module: "cloud-orbital-ladder-model.mjs",
    call: (m) =>
      m.imageAerialCapFraction(RGBA_SYNTHETIC, {
        width: W,
        height: H,
        cloudMask: ALL_MASK,
        aerialColor: { r: 0.5, g: 0.55, b: 0.62 },
      }),
    report: (v) => v.fraction,
  },
  {
    name: "imageAerialCapFraction/uniform-all-capped",
    module: "cloud-orbital-ladder-model.mjs",
    call: (m) =>
      m.imageAerialCapFraction(RGBA_UNIFORM, {
        width: W,
        height: H,
        cloudMask: null,
        aerialColor: { r: 128 / 255, g: 128 / 255, b: 128 / 255 },
        tolerance: 0.15,
      }),
    report: (v) => v.fraction,
  },
  {
    name: "imageAerialCapFraction/empty-mask-zero-population",
    module: "cloud-orbital-ladder-model.mjs",
    call: (m) =>
      m.imageAerialCapFraction(RGBA_ZERO, {
        width: W,
        height: H,
        cloudMask: EMPTY_MASK,
        aerialColor: { r: 0, g: 0, b: 0 },
      }),
    report: (v) => String(v.fraction),
  },
  {
    name: "imageAerialCapFraction/missing-aerial-colour-refused",
    module: "cloud-orbital-ladder-model.mjs",
    call: (m) =>
      outcome(() =>
        m.imageAerialCapFraction(RGBA_ZERO, {
          width: W,
          height: H,
          cloudMask: null,
          aerialColor: null,
        }),
      ),
    report: (v) => v.threw,
  },
];

/** Moved name -> the metrics module that must now own its single implementation. */
const MOVED = [
  ["cloud-photometry.mjs", "circularMask", "masks"],
  ["cloud-photometry.mjs", "rectRoi", "masks"],
  ["cloud-photometry.mjs", "luminance", "luminance"],
  ["cloud-photometry.mjs", "forwardReinhard", "luminance"],
  ["cloud-photometry.mjs", "inverseReinhard", "luminance"],
  ["cloud-photometry.mjs", "displaySpaceLuminanceMean", "luminance"],
  ["cloud-photometry.mjs", "REINHARD_OPERATOR_PIN", "luminance"],
  ["cloud-photometry.mjs", "EXPOSURE_UNIFORM_SLOT", "luminance"],
  ["cloud-photometry.mjs", "DEFAULT_CLOUD_EXPOSURE", "luminance"],
  ["cloud-photometry.mjs", "TRANSFER_FUNCTIONS", "luminance"],
  ["cloud-photometry.mjs", "DEFAULT_TRANSFER", "luminance"],
  ["cloud-photometry.mjs", "photometricStats", "saturation"],
  ["cloud-photometry.mjs", "photometricRatio", "saturation"],
  ["cloud-photometry.mjs", "DEFAULT_SATURATION_CEILING", "saturation"],
  ["cloud-spectrum.mjs", "radialPowerSpectrum", "spectralSlope"],
  ["cloud-spectrum.mjs", "fitSpectralSlope", "spectralSlope"],
  ["cloud-spectrum.mjs", "areaPerimeterFractalDimension", "spectralSlope"],
  ["cloud-spectrum.mjs", "syntheticFractionalBrownianField", "spectralSlope"],
  ["cloud-orbital-ladder-model.mjs", "meanCloudAlpha", "regionMeans"],
  ["cloud-orbital-ladder-model.mjs", "imageAerialCapFraction", "regionMeans"],
];

// ── assertion 1 ─────────────────────────────────────────────────────────────

test("every name the three cloud modules exported before the move is still exported after it", () => {
  for (const fileName of MODULES) {
    const beforeNames = GOLDEN.exports[fileName];
    const afterNames = new Set(Object.keys(after[fileName]));
    assert.ok(
      Array.isArray(beforeNames) && beforeNames.length > 0,
      `${fileName}: the fixture records no pre-move exports, so the comparison would be vacuous`,
    );
    const missing = beforeNames.filter((name) => !afterNames.has(name));
    assert.deepStrictEqual(
      missing,
      [],
      `${fileName} stopped exporting ${missing.join(", ")}`,
    );
  }
});

// ── assertion 2 ─────────────────────────────────────────────────────────────

test("every moved function returns bit-for-bit what its pre-move body returned", () => {
  const table = [];
  const unused = new Set(Object.keys(GOLDEN.cases));
  for (const testCase of CASES) {
    const golden = GOLDEN.cases[testCase.name];
    assert.ok(
      golden !== undefined,
      `${testCase.name}: no pre-move value is recorded in the fixture — a case cannot be added without capturing what the pre-move code returned for it`,
    );
    assert.equal(
      golden.module,
      testCase.module,
      `${testCase.name}: the fixture was captured against ${golden.module}`,
    );
    unused.delete(testCase.name);

    const beforeValue = decodeExact(golden.value);
    const afterValue = withPinnedTrig(() =>
      testCase.call(after[testCase.module]),
    );
    table.push({
      case: testCase.name,
      before: testCase.report(beforeValue),
      after: testCase.report(afterValue),
    });
    assert.deepStrictEqual(
      afterValue,
      beforeValue,
      `${testCase.name}: the moved implementation returned a different value than the pre-move body`,
    );
  }
  console.log(
    `\nbefore/after, pre-move fixture (captured ${GOLDEN.capturedOn} at ${GOLDEN.capturedFrom.slice(0, 10)}) vs moved body:`,
  );
  console.table(table);
  assert.equal(
    table.length,
    CASES.length,
    "every case must have been compared against the fixture",
  );
  assert.deepStrictEqual(
    [...unused],
    [],
    "the fixture records cases this spec no longer runs — deleting a case silently drops its evidence",
  );
});

test("the pinned trigonometry is the sine and cosine, to within one double spacing at 1", () => {
  // The pin is only a fair stand-in for the engine's pair if it computes the
  // same functions: a pin that drifted would make assertion 2 compare a
  // different field. Both pairs are checked on the DFT's own angles and on a
  // dense sweep past them; quarter-turn multiples must keep their exact zeros.
  let worst = 0;
  for (let i = 0; i <= 20000; i++) {
    const x = -160 + (320 * i) / 20000;
    worst = Math.max(
      worst,
      Math.abs(pinnedSin(x) - Math.sin(x)),
      Math.abs(pinnedCos(x) - Math.cos(x)),
    );
  }
  for (let k = 0; k < 24; k++) {
    for (let t = 0; t < 24; t++) {
      const angle = (-2 * Math.PI * k * t) / 24;
      worst = Math.max(
        worst,
        Math.abs(pinnedSin(angle) - Math.sin(angle)),
        Math.abs(pinnedCos(angle) - Math.cos(angle)),
      );
    }
  }
  assert.ok(
    worst <= Number.EPSILON,
    `pinned sin/cos depart from the engine's by ${worst}, more than one double spacing at 1`,
  );
  assert.ok(Object.is(pinnedSin(-0), -0), "sin(-0) must stay -0");
  assert.equal(pinnedCos(0), 1);
  assert.equal(pinnedSin(Math.PI / 2), 1);
});

// ── assertion 3 ─────────────────────────────────────────────────────────────

test("exactly one implementation of each moved name exists: the old module re-exports the new one's binding", () => {
  for (const [fileName, name, metricsKey] of MOVED) {
    assert.ok(
      name in metrics[metricsKey],
      `${name} is not exported by lib/metrics/${metricsKey}`,
    );
    assert.strictEqual(
      after[fileName][name],
      metrics[metricsKey][name],
      `${fileName} exports its own copy of ${name} rather than re-exporting lib/metrics`,
    );
  }
});

// ── assertion 4 ─────────────────────────────────────────────────────────────

test("the fixture codec is lossless for every shape these cases produce", () => {
  // Assertion 2 is only as strong as the encoding the fixture was written in. If
  // the codec flattened a -0, a NaN or a typed array's element type, the
  // comparison would pass over a value that had already been rounded off on its
  // way to disk. Every live value is therefore pushed through the codec and back
  // and required to come out bit-identical, and the four doubles JSON cannot
  // hold are checked directly rather than left to whether a case happens to
  // produce one.
  for (const testCase of CASES) {
    const value = testCase.call(after[testCase.module]);
    assert.deepStrictEqual(
      decodeExact(encodeExact(value)),
      value,
      `${testCase.name}: the codec did not round-trip this value`,
    );
  }
  for (const awkward of [
    -0,
    0,
    NaN,
    Infinity,
    -Infinity,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    Number.EPSILON,
    0.1 + 0.2,
  ]) {
    assert.deepStrictEqual(decodeExact(encodeExact(awkward)), awkward);
  }
  assert.deepStrictEqual(
    decodeExact(encodeExact(new Float64Array([-0, NaN, 1 / 3]))),
    new Float64Array([-0, NaN, 1 / 3]),
  );
  assert.deepStrictEqual(decodeExact(encodeExact(undefined)), undefined);
});
