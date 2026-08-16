// celestial-metrics.spec.mjs — trust anchor for the Campaign 12 celestial gate
// metric library (C12-01). Run with:  node --test Tools/visual-regression/celestial-metrics.spec.mjs
// @purpose Trust anchor for lib/celestial-metrics.mjs: each metric (census, contrast tail, chroma, falloff, magnitude fidelity) run on closed-form images.
// @status ACTIVE
//
// Every metric is exercised on a SYNTHETIC image whose ground truth is known in
// closed form, so a regression in the metric maths fails here long before any
// browser probe runs. No Playwright, no engine, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  srgbToLinear,
  percentile,
  spearman,
  m1PointSourceCensus,
  m2ContrastTail,
  m2eSkyFloor,
  m3Chroma,
  m4RadialFalloff,
  m5MagnitudeFidelity,
} from "./lib/celestial-metrics.mjs";

// ---------------------------------------------------------------------------
// Synthetic-image builders
// ---------------------------------------------------------------------------

// A flat 8-bit RGBA field of a single gray level.
function flatImage(width, height, level) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = level;
    data[i + 1] = level;
    data[i + 2] = level;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

// Stamp a Gaussian blob of a given (per-channel) colour onto an 8-bit image.
// Each channel value = round(color[c] * exp(-r^2 / (2 sigma^2))), so the centre
// pixel is exactly `color` and is a strict local maximum of luminance.
function stampGaussianBlob(image, cx, cy, sigma, color) {
  const { data, width, height } = image;
  const rad = Math.ceil(sigma * 4);
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) {
        continue;
      }
      const g = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      const i = (y * width + x) * 4;
      data[i] = Math.max(data[i], Math.round(color[0] * g));
      data[i + 1] = Math.max(data[i + 1], Math.round(color[1] * g));
      data[i + 2] = Math.max(data[i + 2], Math.round(color[2] * g));
      data[i + 3] = 255;
    }
  }
}

// Twelve well-separated blob centres (>= 18 px apart, >= 8 px from any border).
const BLOB_POSITIONS = [
  [20, 20],
  [60, 22],
  [100, 18],
  [140, 24],
  [180, 20],
  [30, 70],
  [90, 74],
  [150, 68],
  [40, 120],
  [110, 124],
  [170, 118],
  [95, 170],
];

// A radially-symmetric LINEAR-light float RGBA image (peak = 1.0 at centre),
// used for M4 where an 8-bit target cannot represent 1e-3 of peak.
function radialFloatImage(size, radialFn) {
  const c = (size - 1) / 2;
  const data = new Float64Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c));
      const v = radialFn(r);
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 1;
    }
  }
  return { image: { data, width: size, height: size }, centre: Math.round(c) };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("srgbToLinear matches sRGB EOTF anchor points", () => {
  assert.equal(srgbToLinear(0), 0);
  assert.ok(Math.abs(srgbToLinear(1) - 1) < 1e-9);
  // Mid-gray 0.5 sRGB decodes to ~0.2140 linear.
  assert.ok(Math.abs(srgbToLinear(0.5) - 0.2140411) < 1e-4);
});

test("percentile interpolates and clamps", () => {
  const s = [0, 1, 2, 3, 4];
  assert.equal(percentile(s, 0.5), 2);
  assert.equal(percentile(s, 0), 0);
  assert.equal(percentile(s, 1), 4);
  assert.ok(Math.abs(percentile(s, 0.25) - 1) < 1e-9);
});

test("spearman is 1 for a monotonic pair, -1 for reversed", () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-9);
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [40, 30, 20, 10]) + 1) < 1e-9);
});

// ---------------------------------------------------------------------------
// M1 — point-source census
// ---------------------------------------------------------------------------

test("M1 counts a known Gaussian blob field exactly and locates each", () => {
  const img = flatImage(200, 200, 0);
  for (const [x, y] of BLOB_POSITIONS) {
    stampGaussianBlob(img, x, y, 1.4, [220, 220, 220]);
  }
  const { count, sources } = m1PointSourceCensus(img);
  assert.equal(count, BLOB_POSITIONS.length, "one source per blob, no extras");
  for (const [x, y] of BLOB_POSITIONS) {
    const hit = sources.find(
      (s) => Math.abs(s.x - x) <= 1 && Math.abs(s.y - y) <= 1,
    );
    assert.ok(hit, `blob at ${x},${y} detected`);
    assert.ok(hit.peak > hit.background, "peak above local background");
  }
});

test("M1 reports zero sources on a flat field", () => {
  const flat = flatImage(120, 120, 40);
  assert.equal(m1PointSourceCensus(flat).count, 0);
});

test("M1 is immune to a uniform multiplicative fade (differential)", () => {
  // Halving every channel must not change the source count: the census tests
  // (P - B) against a local background, not an absolute level.
  const bright = flatImage(200, 200, 0);
  const dim = flatImage(200, 200, 0);
  for (const [x, y] of BLOB_POSITIONS) {
    stampGaussianBlob(bright, x, y, 1.6, [240, 240, 240]);
    stampGaussianBlob(dim, x, y, 1.6, [140, 140, 140]);
  }
  assert.equal(
    m1PointSourceCensus(bright).count,
    m1PointSourceCensus(dim).count,
  );
});

// ---------------------------------------------------------------------------
// M4 — radial falloff separates a Moffat wing from a truncated Gaussian
// ---------------------------------------------------------------------------

test("M4 separates a Moffat PSF (ratio >= 8) from a truncated Gaussian (< 2)", () => {
  // Moffat I(r) = (1 + (r/alpha)^2)^(-beta). ratio r_1e-3/r_core depends only on
  // beta: for beta = 1.9 it is ~9.15, independent of alpha.
  const alpha = 5.5;
  const beta = 1.9;
  const moffat = radialFloatImage(96, (r) =>
    Math.pow(1 + (r / alpha) * (r / alpha), -beta),
  );
  const mM = m4RadialFalloff(
    moffat.image,
    { x: moffat.centre, y: moffat.centre },
    {
      alreadyLinear: true,
    },
  );
  assert.ok(mM.ratio1e3 >= 8, `Moffat ratio ${mM.ratio1e3} >= 8`);
  // Two agreeing power-law slopes, both in [-5, -2] (the G2 wing criterion).
  assert.ok(
    mM.slopeInner <= -2 && mM.slopeInner >= -5,
    `inner slope ${mM.slopeInner}`,
  );
  assert.ok(
    mM.slopeOuter <= -2 && mM.slopeOuter >= -5,
    `outer slope ${mM.slopeOuter}`,
  );
  assert.ok(
    Math.abs(mM.slopeInner - mM.slopeOuter) < 0.9,
    `slopes agree: ${mM.slopeInner} vs ${mM.slopeOuter}`,
  );

  // Truncated Gaussian: hard zero beyond r = 5 -> cannot reach 1e-3 far out, so
  // r_1e-3 sits at the truncation edge and the ratio collapses below 2.
  const sigma = 3.4;
  const rTrunc = 5;
  const gauss = radialFloatImage(96, (r) =>
    r > rTrunc ? 0 : Math.exp(-(r * r) / (2 * sigma * sigma)),
  );
  const mG = m4RadialFalloff(
    gauss.image,
    { x: gauss.centre, y: gauss.centre },
    {
      alreadyLinear: true,
    },
  );
  assert.ok(mG.ratio1e3 < 2, `truncated-Gaussian ratio ${mG.ratio1e3} < 2`);
  assert.ok(
    mM.ratio1e3 / mG.ratio1e3 > 4,
    "Moffat and Gaussian are cleanly separated",
  );
});

// ---------------------------------------------------------------------------
// M2 — contrast / tail separates a flat field from a contrasty one
// ---------------------------------------------------------------------------

test("M2 distinguishes a flat field from a contrasty, clipped one", () => {
  const flat = flatImage(200, 200, 50);
  const contrasty = flatImage(200, 200, 10);
  // Scatter 200 hard-white (clipped) pixels across the contrasty field.
  let placed = 0;
  for (let k = 0; placed < 200; k++) {
    const x = (k * 37) % 200;
    const y = (k * 53) % 200;
    const i = (y * 200 + x) * 4;
    if (contrasty.data[i] !== 255) {
      contrasty.data[i] = 255;
      contrasty.data[i + 1] = 255;
      contrasty.data[i + 2] = 255;
      placed++;
    }
  }

  const mFlat = m2ContrastTail(flat);
  const mContrast = m2ContrastTail(contrasty);

  assert.ok(mFlat.rmsContrast < 1e-9, "flat field has zero RMS contrast");
  assert.equal(mFlat.clipCount, 0, "flat field has no clipped pixels");
  assert.ok(Math.abs(mFlat.p999MinusP50) < 1e-9, "flat field has no tail");

  assert.ok(
    mContrast.rmsContrast > 1.0,
    "contrasty field has high RMS contrast",
  );
  assert.equal(
    mContrast.clipCount,
    200,
    "clip census counts every white pixel",
  );
  assert.ok(
    mContrast.p999MinusP50 > mFlat.p999MinusP50,
    "contrasty field has a real bright tail",
  );
});

test("M2e sky floor uses a robust percentile, not the raw min", () => {
  const img = flatImage(100, 100, 30);
  // A single dead-black pixel must not drag the floor to 0.
  img.data[0] = 0;
  img.data[1] = 0;
  img.data[2] = 0;
  const { skyFloor, rawMin } = m2eSkyFloor(img);
  assert.equal(rawMin, 0, "raw min sees the dead pixel");
  assert.ok(skyFloor > 0, "robust floor rejects the single dead pixel");
});

// ---------------------------------------------------------------------------
// M3 — chroma separates a monochrome field from a coloured one
// ---------------------------------------------------------------------------

test("M3 distinguishes a monochrome star field from a coloured one", () => {
  const mono = flatImage(200, 200, 0);
  const colour = flatImage(200, 200, 0);
  const starColours = [
    [255, 180, 120], // warm / orange
    [120, 170, 255], // cool / blue
  ];
  for (let k = 0; k < BLOB_POSITIONS.length; k++) {
    const [x, y] = BLOB_POSITIONS[k];
    stampGaussianBlob(mono, x, y, 1.5, [210, 210, 210]);
    stampGaussianBlob(colour, x, y, 1.5, starColours[k % starColours.length]);
  }

  const monoSources = m1PointSourceCensus(mono).sources;
  const colourSources = m1PointSourceCensus(colour).sources;
  assert.equal(monoSources.length, BLOB_POSITIONS.length);
  assert.equal(colourSources.length, BLOB_POSITIONS.length);

  const mMono = m3Chroma(mono, monoSources);
  const mColour = m3Chroma(colour, colourSources);

  assert.ok(mMono.medianSaturation < 0.05, "monochrome field is unsaturated");
  assert.ok(mColour.medianSaturation > 0.3, "coloured field is saturated");
  assert.ok(
    mColour.hueIQR > mMono.hueIQR + 20,
    `coloured hue spread (${mColour.hueIQR}) exceeds monochrome (${mMono.hueIQR})`,
  );
});

// ---------------------------------------------------------------------------
// M5 — magnitude fidelity recovers a perfect Pogson law
// ---------------------------------------------------------------------------

test("M5 recovers Spearman ~1, exponent ~1 and a wide flux span for a faithful render", () => {
  const scale = 100;
  const expectations = [
    { screenX: 10, screenY: 10, vmag: -1 },
    { screenX: 50, screenY: 10, vmag: 0 },
    { screenX: 90, screenY: 10, vmag: 1 },
    { screenX: 130, screenY: 10, vmag: 2 },
    { screenX: 170, screenY: 10, vmag: 3 },
  ];
  // Perfect Pogson: rendered peak proportional to relative flux 10^(-0.4 vmag).
  const detections = expectations.map((e) => ({
    x: e.screenX,
    y: e.screenY,
    peak: scale * Math.pow(10, -0.4 * e.vmag),
  }));

  const m = m5MagnitudeFidelity(expectations, detections);
  assert.equal(m.matched.length, 5, "all five cross-match within 3 px");
  assert.ok(m.spearman > 0.99, `spearman ${m.spearman}`);
  assert.ok(Math.abs(m.exponent - 1) < 0.05, `exponent ${m.exponent} ~ 1`);
  assert.ok(
    m.brightestFaintestRatio > 15,
    `flux span ${m.brightestFaintestRatio} > 15`,
  );
});

test("M5 rejects a detection outside the cross-match radius", () => {
  const expectations = [
    { screenX: 10, screenY: 10, vmag: 0 },
    { screenX: 50, screenY: 10, vmag: 1 },
  ];
  const detections = [
    { x: 10, y: 10, peak: 100 },
    { x: 58, y: 10, peak: 40 }, // 8 px away -> beyond the 3 px gate
  ];
  const m = m5MagnitudeFidelity(expectations, detections);
  assert.equal(m.matched.length, 1, "only the in-tolerance detection matches");
});
