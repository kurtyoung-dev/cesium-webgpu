// @purpose node:test guard for lib/cloud-spectrum.mjs (C13-N04, O5 Structure):
//   validate the radial power-spectrum slope fit and the area-perimeter
//   fractal dimension against synthetic fields of KNOWN answer before either
//   statistic is ever pointed at a render.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import {
  areaPerimeterFractalDimension,
  fitSpectralSlope,
  radialPowerSpectrum,
  syntheticFractionalBrownianField,
} from "./lib/cloud-spectrum.mjs";

const SIZE = 128;
const METRES_PER_PIXEL = 4000; // 4 km/px -> 512 km square domain, 8 km Nyquist
const BAND = { minWavelengthMetres: 5000, maxWavelengthMetres: 500000 }; // O5's 5-500 km band

function recoverSlope(slope, seed) {
  const field = syntheticFractionalBrownianField({
    width: SIZE,
    height: SIZE,
    slope,
    seed,
  });
  const spectrum = radialPowerSpectrum(field, {
    width: SIZE,
    height: SIZE,
    metresPerPixel: METRES_PER_PIXEL,
  });
  return fitSpectralSlope(spectrum, BAND);
}

// Tolerance derivation (not guessed): a 30-seed sweep at the physical target
// (-5/3) measured mean error +0.028 and max |error| 0.182 at SIZE=128; a
// 20-seed sweep at -1.0 and -2.5 measured max |error| 0.162 and 0.121. The
// small positive mean bias (recovered slightly less steep than authored) is
// the Hann window's low-k resolution loss, not a caller bug, and it is well
// inside this margin. 0.25 covers every observed sample with headroom
// without being so loose it would pass a broken fit.
const SLOPE_TOLERANCE = 0.25;

test("recovers a known spectral slope within the characterized tolerance", () => {
  const cases = [
    { slope: -5 / 3, seed: 1 },
    { slope: -5 / 3, seed: 2 },
    { slope: -1.0, seed: 1 },
    { slope: -1.0, seed: 2 },
    { slope: -2.5, seed: 1 },
    { slope: -2.5, seed: 2 },
  ];
  for (const { slope, seed } of cases) {
    const fit = recoverSlope(slope, seed);
    assert.equal(
      fit.failures.length,
      0,
      `unexpected failures: ${fit.failures}`,
    );
    assert.ok(fit.sampleCount >= 5);
    assert.ok(
      Math.abs(fit.slope - slope) <= SLOPE_TOLERANCE,
      `authored ${slope}, recovered ${fit.slope} (seed ${seed}), tolerance ${SLOPE_TOLERANCE}`,
    );
  }
});

test("discriminates two authored slopes narrower than the +/-0.3 gate band", () => {
  // O5's gate is +/-0.3 wide, so the analyzer must resolve a gap SMALLER than
  // that or it cannot tell a passing render from a failing one. 0.25 < 0.3.
  const steeper = -1.8;
  const shallower = -1.55;
  let orderedCorrectly = 0;
  const trials = 8;
  for (let trial = 0; trial < trials; trial++) {
    const shallowFit = recoverSlope(shallower, 100 + trial);
    const steepFit = recoverSlope(steeper, 900 + trial); // independent seed stream
    assert.equal(shallowFit.failures.length, 0);
    assert.equal(steepFit.failures.length, 0);
    if (shallowFit.slope > steepFit.slope) {
      orderedCorrectly++;
    }
  }
  // Require it to win essentially every trial, not just on average, since a
  // gate that is right 60% of the time is not usable as a gate.
  assert.ok(
    orderedCorrectly >= trials - 1,
    `expected the shallower slope to score higher in nearly every trial, got ${orderedCorrectly}/${trials}`,
  );
});

test("rejects a constant field instead of returning a confident slope", () => {
  const field = new Float64Array(SIZE * SIZE).fill(0.42);
  const spectrum = radialPowerSpectrum(field, {
    width: SIZE,
    height: SIZE,
    metresPerPixel: METRES_PER_PIXEL,
  });
  const fit = fitSpectralSlope(spectrum, BAND);
  assert.equal(fit.slope, null);
  assert.ok(
    fit.failures.length > 0,
    "expected a stated failure for a constant field",
  );
});

test("rejects an all-zero field instead of returning a confident slope", () => {
  const field = new Float64Array(SIZE * SIZE);
  const spectrum = radialPowerSpectrum(field, {
    width: SIZE,
    height: SIZE,
    metresPerPixel: METRES_PER_PIXEL,
  });
  const fit = fitSpectralSlope(spectrum, BAND);
  assert.equal(fit.slope, null);
  assert.ok(
    fit.failures.length > 0,
    "expected a stated failure for an all-zero field",
  );
});

test("rejects a band restriction that leaves too few bins", () => {
  const field = syntheticFractionalBrownianField({
    width: SIZE,
    height: SIZE,
    slope: -5 / 3,
    seed: 7,
  });
  const spectrum = radialPowerSpectrum(field, {
    width: SIZE,
    height: SIZE,
    metresPerPixel: METRES_PER_PIXEL,
  });
  // A 500 m wide band at 4 km/px resolution cannot contain 5 distinct bins.
  const fit = fitSpectralSlope(spectrum, {
    minWavelengthMetres: 100000,
    maxWavelengthMetres: 100500,
  });
  assert.equal(fit.slope, null);
  assert.ok(
    fit.failures.length > 0,
    "expected a stated failure for a starved band",
  );
  assert.ok(fit.sampleCount < 5);
});

// --- area-perimeter fractal dimension -------------------------------------

/** Fills axis-aligned discs of the given (center, radius) triples. */
function buildDiscsField(width, height, discs) {
  const field = new Float64Array(width * height);
  for (const [cx, cy, r] of discs) {
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const y1 = Math.min(height - 1, Math.ceil(cy + r + 1));
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const x1 = Math.min(width - 1, Math.ceil(cx + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) {
          field[y * width + x] = 1;
        }
      }
    }
  }
  return field;
}

/**
 * Fills blobs whose radius ripples with a high-frequency angular term, which
 * inflates perimeter per unit area (a crenellated/gear-toothed outline) far
 * more than a smooth disc — the calibration anchor for "materially higher D".
 */
function buildCrenellatedField(width, height, blobs) {
  const field = new Float64Array(width * height);
  for (const [cx, cy, r, teeth, amplitude] of blobs) {
    const rMax = r * (1 + amplitude) + 2;
    const y0 = Math.max(0, Math.floor(cy - rMax - 1));
    const y1 = Math.min(height - 1, Math.ceil(cy + rMax + 1));
    const x0 = Math.max(0, Math.floor(cx - rMax - 1));
    const x1 = Math.min(width - 1, Math.ceil(cx + rMax + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.hypot(dx, dy);
        const theta = Math.atan2(dy, dx);
        const localRadius = r * (1 + amplitude * Math.sin(teeth * theta));
        if (dist <= localRadius) {
          field[y * width + x] = 1;
        }
      }
    }
  }
  return field;
}

const DISC_RADII = [6, 9, 12, 16, 20, 25, 30, 36];

/** Lays out one row of shapes (discs or crenellated blobs) with no overlap. */
function layoutRow(radii, centerY, shapeFor) {
  let cursor = 60;
  const shapes = [];
  for (const r of radii) {
    const halfExtent = shapeFor.halfExtent(r);
    cursor += halfExtent;
    shapes.push(shapeFor.make(cursor, centerY, r));
    cursor += halfExtent + 30;
  }
  return { shapes, extent: cursor + 60 };
}

test("area-perimeter fractal dimension: ~1.0 for smooth discs, materially higher for rough blobs", () => {
  const discShapeFor = {
    halfExtent: (r) => r,
    make: (x, y, r) => [x, y, r],
  };
  const row1 = layoutRow(DISC_RADII, 70, discShapeFor);
  const row2 = layoutRow(DISC_RADII, 260, discShapeFor);
  const smoothWidth = Math.ceil(Math.max(row1.extent, row2.extent));
  const smoothField = buildDiscsField(smoothWidth, 400, [
    ...row1.shapes,
    ...row2.shapes,
  ]);
  const smoothResult = areaPerimeterFractalDimension(smoothField, {
    width: smoothWidth,
    height: 400,
    thresholds: [0.5],
  });

  assert.equal(smoothResult.failures.length, 0);
  assert.ok(smoothResult.blobCount >= 5);
  // Calibration anchor: a discretized disc set measures D=0.963 here (r2 >
  // 0.999) against the ideal-circle answer of exactly 1.0 — the gap is small
  // per-radius perimeter quantization at these pixel scales, not a bug in
  // the fit (the ideal slope of log(P) vs log(A) for a true circle is 0.5
  // regardless of the proportionality constant, so this is a real, if
  // small, discretization effect). 0.12 covers that measured gap (0.037)
  // with margin.
  assert.ok(
    Math.abs(smoothResult.dimension - 1.0) <= 0.12,
    `expected smooth-disc dimension near 1.0, got ${smoothResult.dimension}`,
  );

  const roughShapeFor = {
    halfExtent: (r) => r * 1.5,
    make: (x, y, r) => [x, y, r, Math.max(6, Math.round(r / 2)), 0.5],
  };
  const roughRow1 = layoutRow(DISC_RADII, 70, roughShapeFor);
  const roughRow2 = layoutRow(DISC_RADII, 260, roughShapeFor);
  const roughWidth = Math.ceil(Math.max(roughRow1.extent, roughRow2.extent));
  const roughField = buildCrenellatedField(roughWidth, 400, [
    ...roughRow1.shapes,
    ...roughRow2.shapes,
  ]);
  const roughResult = areaPerimeterFractalDimension(roughField, {
    width: roughWidth,
    height: 400,
    thresholds: [0.5],
  });

  assert.equal(roughResult.failures.length, 0);
  assert.ok(roughResult.blobCount >= 5);
  // Measured 1.609 here vs 0.963 for the smooth set — a >0.3 gap is "smooth"
  // vs "rough" being unmistakably distinguishable, well clear of noise.
  assert.ok(
    roughResult.dimension - smoothResult.dimension > 0.3,
    `expected rough blobs to score materially higher: smooth=${smoothResult.dimension}, rough=${roughResult.dimension}`,
  );
});

test("area-perimeter fractal dimension rejects too few surviving blobs", () => {
  const field = buildDiscsField(200, 200, [[100, 100, 40]]); // one blob only
  const result = areaPerimeterFractalDimension(field, {
    width: 200,
    height: 200,
    thresholds: [0.5],
  });
  assert.equal(result.dimension, null);
  assert.ok(result.failures.length > 0);
});

// --- determinism -----------------------------------------------------------

test("same seed produces a byte-identical field and identical statistics", () => {
  const optionsA = { width: 64, height: 64, slope: -5 / 3, seed: 12345 };
  const optionsB = { width: 64, height: 64, slope: -5 / 3, seed: 12345 };
  const fieldA = syntheticFractionalBrownianField(optionsA);
  const fieldB = syntheticFractionalBrownianField(optionsB);
  assert.equal(fieldA.length, fieldB.length);
  for (let i = 0; i < fieldA.length; i++) {
    assert.equal(fieldA[i], fieldB[i], `byte mismatch at index ${i}`);
  }

  const spectrumA = radialPowerSpectrum(fieldA, {
    width: 64,
    height: 64,
    metresPerPixel: 4000,
  });
  const spectrumB = radialPowerSpectrum(fieldB, {
    width: 64,
    height: 64,
    metresPerPixel: 4000,
  });
  const fitA = fitSpectralSlope(spectrumA, BAND);
  const fitB = fitSpectralSlope(spectrumB, BAND);
  assert.equal(fitA.slope, fitB.slope);
  assert.equal(fitA.r2, fitB.r2);
  assert.deepEqual(fitA.failures, fitB.failures);

  // A different seed must (overwhelmingly likely) diverge, or "determinism"
  // would be trivially satisfied by a constant-output bug.
  const fieldC = syntheticFractionalBrownianField({ ...optionsA, seed: 54321 });
  assert.notEqual(fieldC[0], fieldA[0]);
});

// --- band arithmetic ---------------------------------------------------------

test("maps the 5-500 km band to the expected physical bins, and catches a units mistake", () => {
  const field = syntheticFractionalBrownianField({
    width: SIZE,
    height: SIZE,
    slope: -5 / 3,
    seed: 42,
  });

  // Correct units: metresPerPixel = 4000 (4 km/px, 512 km domain). The 512 km
  // domain sits inside the 500 km cap only slightly over, and the ~8 km
  // Nyquist limit sits well above the 5 km floor, so every achievable
  // non-DC bin should qualify for the requested band.
  const spectrum = radialPowerSpectrum(field, {
    width: SIZE,
    height: SIZE,
    metresPerPixel: METRES_PER_PIXEL,
  });
  const fit = fitSpectralSlope(spectrum, BAND);
  const expectedBandBinCount = spectrum.bins.filter(
    (bin) => bin.wavelengthMetres >= 5000 && bin.wavelengthMetres <= 500000,
  ).length;
  assert.equal(fit.bandBins.length, expectedBandBinCount);
  assert.equal(fit.bandBins.length, spectrum.bins.length); // nothing should be clipped here
  assert.equal(fit.failures.length, 0);
  assert.ok(
    fit.bandBins.every(
      (bin) => bin.wavelengthMetres >= 5000 && bin.wavelengthMetres <= 500000,
    ),
  );

  // Units mistake: metresPerPixel = 4 (as if a caller passed km-as-metres by
  // accident, i.e. forgot the *1000). Every wavelength collapses by 1000x
  // into the metre scale, entirely below the 5 km floor — a unit bug that
  // would otherwise only surface as a wrong-looking slope on a real render.
  const brokenSpectrum = radialPowerSpectrum(field, {
    width: SIZE,
    height: SIZE,
    metresPerPixel: 4,
  });
  const brokenFit = fitSpectralSlope(brokenSpectrum, BAND);
  assert.equal(brokenFit.bandBins.length, 0);
  assert.ok(brokenFit.failures.length > 0);
});
