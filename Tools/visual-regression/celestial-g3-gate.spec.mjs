// celestial-g3-gate.spec.mjs — browser-free guard for the Campaign-12 G3 lane
// (`probe-celestial-gates.mjs --g3`).
//
// G3 is a gate, so a spec that only ran the correct implementation would be
// worth nothing: the wrong implementation of every rule below also "passes", it
// just passes vacuously. Every rule is stated once and run twice — against the
// real module, and against the plausible wrong implementation somebody would
// actually write.
//
// The spec has five jobs:
//
//   1. PIN THE DEFINITIONS §5 LEFT IMPLICIT. "<= 2.0 arcmin/px" has two
//      candidate readings (nominal span/size, or the tangent-corrected centre
//      density) that differ by 4/pi. The research text's own arithmetic —
//      1024 -> ~5.3, 4096 -> ~1.3, and ">= 2700 px/face" as the equivalent of
//      the 2.0 bar — is reproduced by exactly one of them, and that is the one
//      the module implements. The test recomputes all three statements.
//
//   2. PROVE THE TWO STRUCTURE METRICS ARE ORTHOGONAL. Criterion (4) asks for
//      LARGE-SCALE structure "no point-source metric can see". So the
//      dust-lane IQR must respond to a band and NOT to added stars, while the
//      granularity IQR must do the reverse. Both directions are asserted on
//      synthetic images with known ground truth.
//
//   3. PROVE THE DISCRIMINATOR HAS TEETH — THE T3 ADVERSARIAL. The legacy
//      tycho2t3 faces, pushed through the identical metrics, must FAIL. This is
//      run twice: once on the MEASURED bundled numbers
//      ({@link BUNDLED_ASSET_DERIVATION}) through the verdict half, and once on
//      the REAL BYTES for the format arm, which needs no image decode at all.
//
//   4. PROVE THE COMPOSITION RULES. `{}.every(Boolean)` is vacuously true, a
//      structural leg is neither a pass nor a defect, a pass on ONE backend is
//      a FAIL for a gate over shared code (campaign principle 5), and a
//      reversal trigger can never turn the gate red on its own.
//
//   5. HOLD THE LINE ON THE CENSUS FLOOR. Same tripwire the G1 spec carries,
//      extended to this lane's files: no celestial caller may hand a detector a
//      lowered threshold. Post-DR-01 the honest move is to re-point the CLAIM,
//      never to loosen the detector.
//
// WHAT THIS SPEC DELIBERATELY DOES NOT DO: decode a JPEG. The heavyweight pixel
// pass over the shipped faces runs in the probe (which has `sharp`) and its
// results are recorded in `BUNDLED_ASSET_DERIVATION`; this spec re-derives the
// HEADERS from the real bytes, runs every metric against synthetic ground
// truth, and drives the verdict half with the recorded measurements. That is
// the same division `skybox-diffuse-seam.spec.mjs` uses.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Source-text assertions
// normalize line endings first — a spec anchored on a bare "\n" silently
// false-greens on Windows.
//
// Run: node --test Tools/visual-regression/celestial-g3-gate.spec.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUNDLED_ASSET_DERIVATION,
  CATALOGUE_MIN_LIMITING_MAGNITUDE,
  CATALOGUE_MIN_RECORDS,
  CHROMA_BAND_PERCENTILE,
  CUBE_FACE_SPAN_DEG,
  DR01_LIMITS,
  DR01_LIVE_MAX_RESOLVED_SOURCES,
  DUST_LANE_MARGIN_FRACTION,
  DUST_LANE_SIGMA_DEG,
  EXIT_CODE,
  G3_MAX_ARCMIN_PER_PIXEL,
  G3_MIN_DUST_LANE_IQR_RATIO,
  G3_MIN_FACE_SIZE_PX,
  G3_MIN_MEDIAN_CHROMA,
  G3_MIN_SOURCE_DENSITY_RATIO,
  MOTION_MIN_CHANGED_PIXELS,
  REQUIRED_CHROMA_SUBSAMPLING,
  REVERSAL_TRIGGER,
  STERADIANS_FULL_SKY,
  STERADIANS_PER_FACE,
  TWINKLE_TRIGGER_PEAK_RATIO,
  analyzeFace,
  arcminPerPixel,
  bandChroma,
  boxWidthForSigma,
  buildG3Summary,
  computeAssetTriggers,
  degreesPerPixel,
  dustLaneStructure,
  evaluateAdversarialSubLane,
  evaluateAssetSubLane,
  evaluateCatalogueSubLane,
  evaluateG3Backend,
  evaluateMotionSubLane,
  evaluateSplitSubLane,
  foldG3Verdict,
  foldVariant,
  granularityIQR,
  jpegChromaSubsampling,
  lowPass,
  luminanceStrided,
} from "./lib/celestial-g3-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const readNormalized = (relative) =>
  readFileSync(resolve(ROOT, relative), "utf8").replaceAll("\r\n", "\n");
const PROBE_REL = "Tools/visual-regression/probe-celestial-gates.mjs";
const LIB_REL = "Tools/visual-regression/lib/celestial-g3-gate.mjs";
const PROBE = readNormalized(PROBE_REL);
const ASSET_DIR = "packages/engine/Source/Assets/Textures/SkyBox";
const FACES = ["px", "mx", "py", "my", "pz", "mz"];

// ---------------------------------------------------------------------------
// Synthetic image helpers. Everything is RGBA, stride 4, 8-bit.
// ---------------------------------------------------------------------------

/**
 * A face carrying a smooth DIAGONAL band of a given angular period plus an
 * optional field of point sources. The band is the "dust lane" signal; the
 * points are what criterion (4) is supposed to be blind to.
 */
function syntheticFace({
  size,
  bandAmplitude = 40,
  bandPedestal = 60,
  bandPeriodDeg = 30,
  points = 0,
  pointPeak = 220,
  saturation = 0,
  seed = 12345,
}) {
  const data = new Uint8ClampedArray(size * size * 4);
  const degPerPx = CUBE_FACE_SPAN_DEG / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const deg = (x + y) * degPerPx;
      const v =
        bandPedestal +
        bandAmplitude * Math.sin((2 * Math.PI * deg) / bandPeriodDeg);
      const i = 4 * (y * size + x);
      data[i] = v;
      // A constant HSV saturation of `saturation` about the max channel.
      data[i + 1] = v * (1 - saturation);
      data[i + 2] = v * (1 - saturation);
      data[i + 3] = 255;
    }
  }
  // Deterministic LCG so the point placement is reproducible across runs.
  let s = seed >>> 0;
  const rnd = () => {
    s = (1103515245 * s + 12345) >>> 0;
    return s / 4294967296;
  };
  const margin = 12;
  for (let n = 0; n < points; n++) {
    const px = margin + Math.floor(rnd() * (size - 2 * margin));
    const py = margin + Math.floor(rnd() * (size - 2 * margin));
    const i = 4 * (py * size + px);
    data[i] = pointPeak;
    data[i + 1] = pointPeak;
    data[i + 2] = pointPeak;
  }
  return { data, width: size, height: size, stride: 4 };
}

/** Expand a {@link BUNDLED_ASSET_DERIVATION} row into a `foldVariant` record. */
function variantFixture(row, { maxFaceSources } = {}) {
  return {
    faceCount: 6,
    faceSize: row.faceSize,
    faceSizeMin: row.faceSize,
    arcminPerPixel: row.arcminPerPixel,
    arcminPerPixelWorst: row.arcminPerPixel,
    totalSources: row.totalSources,
    maxFaceSources: maxFaceSources ?? Math.round(row.totalSources / 6),
    sourcesPerSteradian: row.sourcesPerSteradian,
    peakLuminance: row.peakLuminance ?? 255,
    medianDustLaneIQR: row.medianDustLaneIQR,
    medianGranularityIQR: row.medianGranularityIQR,
    medianBandStdDev: row.medianBandStdDev,
    medianChroma: row.medianChroma,
    subsampling: row.subsampling,
    faces: {},
  };
}

const SHIPPED = variantFixture(BUNDLED_ASSET_DERIVATION.t5diffuse, {
  maxFaceSources: 0,
});
const UNBLURRED = variantFixture(BUNDLED_ASSET_DERIVATION.t5, {
  maxFaceSources: 11059,
});
const LEGACY_T3 = variantFixture(BUNDLED_ASSET_DERIVATION.t3, {
  maxFaceSources: 4801,
});
const CHROMA_CONTROL_OK = { medianSaturation: 0.5, expected: 0.5 };

/** A motion record that satisfies every structural guard. */
const MOTION_OK = Object.freeze({
  changedPixels: 91234,
  faintFound: true,
  brightFound: true,
  faintPeakRatio: 3.77,
  faintSumRatio: 1.226,
  brightSumRatio: 1.01,
  frames: 24,
});

/** A split record that satisfies every structural guard and passes. */
const SPLIT_OK = Object.freeze({
  diffuseMaxFaceSources: 0,
  unblurredMinFaceSources: 4143,
  liveResolvedSources: 0,
  liveLitPixels: 512000,
});

/** A catalogue record that satisfies every structural guard and passes. */
const CATALOGUE_OK = Object.freeze({
  records: 2868,
  limitingMagnitude: 5.5,
  liveResolvedSources: 3,
  liveLitPixels: 1840,
});

// ===========================================================================
// 1. DEFINITIONS — the arithmetic §5 left implicit.
// ===========================================================================

test("arcminPerPixel reproduces every arithmetic statement in the research text", () => {
  // "1024/face gives ~5.3 arcmin/px"
  assert.ok(Math.abs(arcminPerPixel(1024) - 5.3) < 0.05);
  // "4096/face gives ~1.3 arcmin/px"
  assert.ok(Math.abs(arcminPerPixel(4096) - 1.3) < 0.05);
  // ">= 2700 px/face" IS the "<= 2.0 arcmin/px" bar.
  assert.equal(arcminPerPixel(G3_MIN_FACE_SIZE_PX), G3_MAX_ARCMIN_PER_PIXEL);
});

test("the tangent-corrected reading is REJECTED as the definition", () => {
  // The centre density of a cube face is coarser than the nominal sampling by
  // 4/pi. Had the gate meant that, none of the three statements above would
  // hold — this test is what stops a future reader "fixing" the formula.
  const tangentCorrected = (n) => (arcminPerPixel(n) * 4) / Math.PI;
  assert.ok(Math.abs(tangentCorrected(1024) - 5.3) > 1.0);
  assert.ok(Math.abs(tangentCorrected(4096) - 1.3) > 0.25);
  assert.notEqual(tangentCorrected(2700), G3_MAX_ARCMIN_PER_PIXEL);
});

test("solid angles tile the sphere exactly", () => {
  assert.ok(Math.abs(STERADIANS_PER_FACE * 6 - STERADIANS_FULL_SKY) < 1e-12);
  assert.ok(
    Math.abs(degreesPerPixel(2048) * 2048 - CUBE_FACE_SPAN_DEG) < 1e-12,
  );
});

test("the dust-lane sigma is pinned in ANGLE, not pixels", () => {
  // 16 px at the shipped 2048 face size. The point of the angular form is that
  // the SAME kernel is applied to faces of different sizes.
  assert.ok(Math.abs(DUST_LANE_SIGMA_DEG - 16 * (90 / 2048)) < 1e-12);
  assert.ok(Math.abs(DUST_LANE_SIGMA_DEG / degreesPerPixel(2048) - 16) < 1e-9);
  assert.ok(Math.abs(DUST_LANE_SIGMA_DEG / degreesPerPixel(1024) - 8) < 1e-9);
});

// ===========================================================================
// 2. LOW-PASS + THE TWO STRUCTURE METRICS.
// ===========================================================================

test("boxWidthForSigma satisfies the variance identity it claims", () => {
  for (const sigma of [4, 8, 16, 32]) {
    const w = boxWidthForSigma(sigma, 3);
    assert.equal(w % 2, 1, "an even box shifts the image by half a pixel");
    const modelled = Math.sqrt((3 * (w * w - 1)) / 12);
    // The ODD constraint biases the realized sigma UP by a consistent ~0.5 px:
    // the ideal width is ~2*sigma, which is even for these sigmas, so the
    // nearest odd is one step wider. That bias is harmless — the same kernel is
    // applied to every tier, so it cancels out of criterion (4)'s ratio — but it
    // is real, and asserting a tight symmetric tolerance instead would be
    // asserting something false.
    const bias = modelled - sigma;
    assert.ok(
      bias >= 0 && bias <= 0.6,
      `sigma ${sigma}: three boxes of ${w} realize ${modelled} (bias ${bias})`,
    );
  }
});

test("the low-pass preserves a constant plane exactly", () => {
  const n = 64;
  const flat = new Float32Array(n * n).fill(37);
  const { plane } = lowPass(flat, n, n, 8);
  for (let i = 0; i < plane.length; i++) {
    assert.ok(Math.abs(plane[i] - 37) < 1e-3, "edge replication leaked");
  }
});

test("dust-lane IQR sees the BAND and is blind to added point sources", () => {
  const size = 256;
  const sigmaPx = DUST_LANE_SIGMA_DEG / degreesPerPixel(size);
  const plain = syntheticFace({ size });
  const starred = syntheticFace({ size, points: 400 });
  const lumPlain = luminanceStrided(plain.data, size, size, 4);
  const lumStarred = luminanceStrided(starred.data, size, size, 4);
  const a = dustLaneStructure(lumPlain, size, size, { sigmaPx });
  const b = dustLaneStructure(lumStarred, size, size, { sigmaPx });
  assert.ok(a.iqr > 10, `the band must register (got ${a.iqr})`);
  assert.ok(
    Math.abs(b.iqr - a.iqr) / a.iqr < 0.1,
    `400 stars moved the dust-lane IQR by ${Math.abs(b.iqr - a.iqr) / a.iqr}`,
  );
});

test("dust-lane IQR collapses when the band is removed", () => {
  const size = 256;
  const sigmaPx = DUST_LANE_SIGMA_DEG / degreesPerPixel(size);
  const banded = syntheticFace({ size });
  const flat = syntheticFace({ size, bandAmplitude: 0 });
  const withBand = dustLaneStructure(
    luminanceStrided(banded.data, size, size, 4),
    size,
    size,
    { sigmaPx },
  );
  const without = dustLaneStructure(
    luminanceStrided(flat.data, size, size, 4),
    size,
    size,
    { sigmaPx },
  );
  assert.ok(withBand.iqr > 20 * Math.max(0.05, without.iqr));
});

test("granularity IQR does the OPPOSITE — it sees stars, not the band", () => {
  const size = 256;
  const sigmaPx = DUST_LANE_SIGMA_DEG / degreesPerPixel(size);
  const plain = syntheticFace({ size });
  const starred = syntheticFace({ size, points: 4000 });
  const a = granularityIQR(
    luminanceStrided(plain.data, size, size, 4),
    size,
    size,
    { sigmaPx },
  );
  const b = granularityIQR(
    luminanceStrided(starred.data, size, size, 4),
    size,
    size,
    { sigmaPx },
  );
  assert.ok(b.iqr > a.iqr, "adding point sources must raise granularity");
  // And the band alone contributes almost nothing at this scale.
  assert.ok(a.iqr < 2.0, `a star-free band leaked ${a.iqr} into granularity`);
});

test("MUTANT: a PIXEL-fixed sigma makes the same sky measure differently at two resolutions", () => {
  // The same angular content sampled at 1024 and 2048. With the shipped ANGULAR
  // sigma the dust-lane IQR agrees; with a naive fixed 16 px it does not, and
  // criterion (4)'s t5-vs-t3 ratio would then be measuring the kernel.
  const small = syntheticFace({ size: 256 });
  const large = syntheticFace({ size: 512 });
  const lumS = luminanceStrided(small.data, 256, 256, 4);
  const lumL = luminanceStrided(large.data, 512, 512, 4);

  const angularS = dustLaneStructure(lumS, 256, 256, {
    sigmaPx: DUST_LANE_SIGMA_DEG / degreesPerPixel(256),
  }).iqr;
  const angularL = dustLaneStructure(lumL, 512, 512, {
    sigmaPx: DUST_LANE_SIGMA_DEG / degreesPerPixel(512),
  }).iqr;
  const angularSpread = Math.abs(angularL - angularS) / angularS;

  const fixedS = dustLaneStructure(lumS, 256, 256, { sigmaPx: 16 }).iqr;
  const fixedL = dustLaneStructure(lumL, 512, 512, { sigmaPx: 16 }).iqr;
  const fixedSpread = Math.abs(fixedL - fixedS) / fixedS;

  assert.ok(
    angularSpread < 0.05,
    `the angular kernel should agree across resolutions (spread ${angularSpread})`,
  );
  assert.ok(
    fixedSpread > 3 * Math.max(angularSpread, 0.01),
    `the pixel-fixed mutant must disagree measurably (spread ${fixedSpread})`,
  );
});

test("the dust-lane margin discards more than the kernel's own support", () => {
  const size = 512;
  const sigmaPx = DUST_LANE_SIGMA_DEG / degreesPerPixel(size);
  const face = syntheticFace({ size });
  const d = dustLaneStructure(
    luminanceStrided(face.data, size, size, 4),
    size,
    size,
    { sigmaPx },
  );
  assert.ok(
    d.marginPx > d.supportPx,
    `margin ${d.marginPx} must exceed kernel support ${d.supportPx}`,
  );
  assert.ok(
    Math.abs(DUST_LANE_MARGIN_FRACTION - 0.1) < 1e-12,
    "the margin fraction is a documented constant",
  );
});

// ===========================================================================
// 3. CHROMA + THE FORMAT ARM.
// ===========================================================================

test("bandChroma recovers a KNOWN saturation — the positive control the probe runs", () => {
  const size = 32;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200;
    data[i + 1] = 100;
    data[i + 2] = 100;
    data[i + 3] = 255;
  }
  const c = bandChroma(data, size, size, 4);
  assert.ok(
    Math.abs(c.medianSaturation - 0.5) < 0.01,
    `expected 0.5, got ${c.medianSaturation}`,
  );
  assert.ok(c.sampleCount > 0);
});

test("bandChroma reports 0 for a neutral face — and that is the ASSET, not the detector", () => {
  const face = syntheticFace({ size: 64, saturation: 0 });
  const c = bandChroma(face.data, 64, 64, 4);
  assert.equal(c.medianSaturation, 0);
  // The pairing is what makes the reading interpretable: the SAME function on a
  // coloured swatch returns 0.5 (previous test), so a 0 here is a fact about the
  // pixels. A gate that reported 0 without the control could not tell the two
  // apart.
  const coloured = syntheticFace({ size: 64, saturation: 0.4 });
  const c2 = bandChroma(coloured.data, 64, 64, 4);
  assert.ok(Math.abs(c2.medianSaturation - 0.4) < 0.02);
});

test("the chroma band cut selects the brightest tenth", () => {
  assert.ok(Math.abs(CHROMA_BAND_PERCENTILE - 0.9) < 1e-12);
  const face = syntheticFace({ size: 128 });
  const c = bandChroma(face.data, 128, 128, 4);
  const total = 128 * 128;
  assert.ok(
    c.sampleCount > 0.03 * total && c.sampleCount < 0.35 * total,
    `band sample ${c.sampleCount} of ${total} is not a top-decile cut`,
  );
});

test("jpegChromaSubsampling reads the REAL bundled faces — t3 is 4:2:0, t5 is 4:4:4", () => {
  // No decode: this is the file's own SOF marker, which is what "fails
  // immediately under 4:2:0 JPEG" is a claim about.
  for (const face of FACES) {
    const t3 = jpegChromaSubsampling(
      readFileSync(resolve(ROOT, ASSET_DIR, `tycho2t3_80_${face}.jpg`)),
    );
    assert.equal(t3.subsampling, "4:2:0", `t3 ${face} is not 4:2:0`);
    for (const prefix of ["tycho2t5_80", "tycho2t5_80_diffuse"]) {
      const t5 = jpegChromaSubsampling(
        readFileSync(resolve(ROOT, ASSET_DIR, `${prefix}_${face}.jpg`)),
      );
      assert.equal(
        t5.subsampling,
        REQUIRED_CHROMA_SUBSAMPLING,
        `${prefix} ${face} is not ${REQUIRED_CHROMA_SUBSAMPLING}`,
      );
      assert.equal(t5.components, 3);
    }
  }
});

test("jpegChromaSubsampling fails CLOSED on anything it cannot parse", () => {
  assert.equal(jpegChromaSubsampling(new Uint8Array(0)).subsampling, "unknown");
  assert.equal(
    jpegChromaSubsampling(new Uint8Array([1, 2, 3, 4])).subsampling,
    "unknown",
  );
  // A valid SOI followed by immediate scan data: a real JPEG shape with no SOF.
  assert.equal(
    jpegChromaSubsampling(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))
      .subsampling,
    "unknown",
  );
});

// ===========================================================================
// 4. analyzeFace / foldVariant end to end on synthetic ground truth.
// ===========================================================================

test("analyzeFace reports the geometry and both structure metrics", () => {
  const face = syntheticFace({ size: 256, points: 200 });
  const rec = analyzeFace(face);
  assert.equal(rec.width, 256);
  assert.ok(Math.abs(rec.arcminPerPixel - arcminPerPixel(256)) < 1e-12);
  assert.ok(rec.dustLaneIQR > 0);
  assert.ok(rec.granularityIQR > 0);
  assert.ok(rec.sources > 0, "planted point sources must be censused");
  assert.ok(
    Math.abs(rec.sourcesPerSteradian - rec.sources / STERADIANS_PER_FACE) <
      1e-9,
  );
  assert.equal(rec.subsampling, null, "no bytes supplied -> no format claim");
});

test("foldVariant takes the MEDIAN of per-face structure, not the mean", () => {
  // Band strength is a property of where a face points. One very strong face
  // must not drag the variant-level number the way a mean would.
  const faces = {};
  for (let i = 0; i < 5; i++) {
    faces[`f${i}`] = {
      width: 2048,
      arcminPerPixel: 2.6,
      sources: 0,
      dustLaneIQR: 1,
      granularityIQR: 0.4,
      bandStdDev: 1,
      medianChroma: 0,
      subsampling: "4:4:4",
    };
  }
  faces.hot = {
    width: 2048,
    arcminPerPixel: 2.6,
    sources: 0,
    dustLaneIQR: 100,
    granularityIQR: 0.4,
    bandStdDev: 9,
    medianChroma: 0,
    subsampling: "4:4:4",
  };
  const v = foldVariant(faces);
  assert.ok(
    v.medianDustLaneIQR < 2,
    `median dragged to ${v.medianDustLaneIQR}`,
  );
  assert.equal(v.faceCount, 6);
  assert.equal(v.subsampling, "4:4:4");
  assert.equal(v.totalSources, 0);
});

test("foldVariant reports MIXED when the faces disagree on format", () => {
  const v = foldVariant({
    a: {
      width: 2048,
      arcminPerPixel: 2.6,
      sources: 0,
      dustLaneIQR: 1,
      granularityIQR: 0.4,
      bandStdDev: 1,
      medianChroma: 0,
      subsampling: "4:4:4",
    },
    b: {
      width: 2048,
      arcminPerPixel: 2.6,
      sources: 0,
      dustLaneIQR: 1,
      granularityIQR: 0.4,
      bandStdDev: 1,
      medianChroma: 0,
      subsampling: "4:2:0",
    },
  });
  assert.equal(v.subsampling, "mixed");
  assert.notEqual(v.subsampling, REQUIRED_CHROMA_SUBSAMPLING);
});

// ===========================================================================
// 5. THE ADVERSARIAL ARM — the legacy t3 asset must FAIL.
// ===========================================================================

test("ADVERSARIAL: the legacy t3 faces pushed through the SAME asset metrics FAIL", () => {
  const asT3Candidate = evaluateAssetSubLane({
    active: LEGACY_T3,
    t3: LEGACY_T3,
    unblurred: UNBLURRED,
    activeVariant: "TYCHO_T3",
    chromaControl: CHROMA_CONTROL_OK,
  });
  assert.equal(asT3Candidate.pass, false, "t3 must not pass the asset arm");
  assert.equal(asT3Candidate.criteria.format_chromaSubsampling_is_444, false);
  assert.equal(asT3Candidate.criteria.asset_arcminPerPixel_le_2_0, false);
  assert.equal(asT3Candidate.criteria.asset_faceSize_ge_2700, false);
  // t3 cannot beat itself: the upgrade predicate is strict.
  assert.equal(asT3Candidate.criteria.asset_angularSampling_beats_t3, false);
});

test("ADVERSARIAL: the shipped diffuse asset BEATS t3 on the arms that discriminate", () => {
  const shipped = evaluateAssetSubLane({
    active: SHIPPED,
    t3: LEGACY_T3,
    unblurred: UNBLURRED,
    activeVariant: "TYCHO_T5_DIFFUSE",
    chromaControl: CHROMA_CONTROL_OK,
  });
  // These are the predicates that SEPARATE the two assets. If they did not, the
  // gate would be unable to tell an upgrade from the thing it replaced.
  assert.equal(shipped.criteria.format_chromaSubsampling_is_444, true);
  assert.equal(shipped.criteria.asset_angularSampling_beats_t3, true);
  assert.equal(shipped.criteria.fidelity_bandStructure_retained, true);
});

test("the adversarial sub-lane PASSES precisely because t3 fails", () => {
  const ok = evaluateAdversarialSubLane({ t3: LEGACY_T3 });
  assert.equal(ok.pass, true);
  assert.equal(ok.criteria.adversarial_t3_fails_format, true);
  assert.equal(ok.criteria.adversarial_t3_fails_angularSampling, true);
  assert.equal(ok.criteria.adversarial_t3_fails_dr01Seam, true);
});

test("MUTANT: a t3 that passed would make the adversarial sub-lane FAIL", () => {
  // Fabricate a t3 that clears every arm — the discriminator is then void, and
  // the gate must say so instead of quietly certifying.
  const fabricated = {
    ...LEGACY_T3,
    subsampling: "4:4:4",
    arcminPerPixel: 1.3,
    arcminPerPixelWorst: 1.3,
    maxFaceSources: 0,
  };
  const bad = evaluateAdversarialSubLane({ t3: fabricated });
  assert.equal(bad.pass, false);
  assert.equal(bad.criteria.adversarial_t3_fails_format, false);
  assert.equal(bad.criteria.adversarial_t3_fails_angularSampling, false);
  assert.equal(bad.criteria.adversarial_t3_fails_dr01Seam, false);
});

test("the adversarial sub-lane is STRUCTURAL, not a pass, when t3 was never measured", () => {
  const missing = evaluateAdversarialSubLane({});
  assert.equal(missing.pass, false);
  assert.equal(Object.keys(missing.criteria).length, 0);
  assert.equal(missing.structural.length, 1);
});

// ===========================================================================
// 6. THE RATIFIED BARS — held, and RED where the shipped asset is red.
// ===========================================================================

test("the ratified bars are §5's own numbers, unmoved", () => {
  assert.equal(G3_MAX_ARCMIN_PER_PIXEL, 2.0);
  assert.equal(G3_MIN_FACE_SIZE_PX, 2700);
  assert.equal(G3_MIN_MEDIAN_CHROMA, 0.2);
  assert.equal(G3_MIN_DUST_LANE_IQR_RATIO, 3.0);
  assert.equal(G3_MIN_SOURCE_DENSITY_RATIO, 10.0);
});

test("the SHIPPED asset is honestly RED on three ratified criteria", () => {
  // This test exists so a future edit that makes G3 green has to change a
  // MEASUREMENT, not a bar. The recorded numbers are what the bundled bytes
  // produce; if the asset is re-baked, this test is the thing that notices.
  const shipped = evaluateAssetSubLane({
    active: SHIPPED,
    t3: LEGACY_T3,
    unblurred: UNBLURRED,
    activeVariant: "TYCHO_T5_DIFFUSE",
    chromaControl: CHROMA_CONTROL_OK,
  });
  assert.equal(shipped.criteria.asset_arcminPerPixel_le_2_0, false);
  assert.equal(shipped.criteria.asset_faceSize_ge_2700, false);
  assert.equal(shipped.criteria.format_medianChroma_ge_0_20, false);
  assert.equal(shipped.criteria.fidelity_dustLaneIQR_ratio_ge_3, false);
  assert.equal(shipped.pass, false);
  assert.ok(shipped.measured.dustLaneIQR_ratio < 1.0);
});

test("even the UN-BLURRED t5 misses three of the four — DR-01 is not the cause", () => {
  const unblurredAsCandidate = evaluateAssetSubLane({
    active: UNBLURRED,
    t3: LEGACY_T3,
    unblurred: UNBLURRED,
    activeVariant: "TYCHO_T5",
    chromaControl: CHROMA_CONTROL_OK,
  });
  assert.equal(
    unblurredAsCandidate.criteria.asset_arcminPerPixel_le_2_0,
    false,
  );
  assert.equal(
    unblurredAsCandidate.criteria.format_medianChroma_ge_0_20,
    false,
  );
  assert.equal(
    unblurredAsCandidate.criteria.fidelity_dustLaneIQR_ratio_ge_3,
    false,
  );
  assert.ok(
    BUNDLED_ASSET_DERIVATION.ratios.sourcesPerSteradian_t5_over_t3 <
      G3_MIN_SOURCE_DENSITY_RATIO,
    "criterion (2) was unreachable with this SVS product even before DR-01",
  );
});

test("a 4096-px re-bake would clear the angular arms — the bar is reachable", () => {
  // Without this, "three criteria are red" could be read as "the bar is
  // impossible", which is a different claim and not the one the evidence
  // supports.
  const rebaked = {
    ...SHIPPED,
    faceSize: 4096,
    faceSizeMin: 4096,
    arcminPerPixel: arcminPerPixel(4096),
    arcminPerPixelWorst: arcminPerPixel(4096),
  };
  const r = evaluateAssetSubLane({
    active: rebaked,
    t3: LEGACY_T3,
    unblurred: UNBLURRED,
    activeVariant: "TYCHO_T5_DIFFUSE",
    chromaControl: CHROMA_CONTROL_OK,
  });
  assert.equal(r.criteria.asset_arcminPerPixel_le_2_0, true);
  assert.equal(r.criteria.asset_faceSize_ge_2700, true);
});

test("the asset sub-lane goes STRUCTURAL when the chroma control does not come back", () => {
  const blind = evaluateAssetSubLane({
    active: SHIPPED,
    t3: LEGACY_T3,
    unblurred: UNBLURRED,
    activeVariant: "TYCHO_T5_DIFFUSE",
    chromaControl: { medianSaturation: 0, expected: 0.5 },
  });
  assert.equal(blind.pass, false);
  assert.equal(Object.keys(blind.criteria).length, 0);
  assert.ok(blind.structural.some((s) => s.includes("positive control")));
});

test("the asset sub-lane goes STRUCTURAL without a t3 baseline", () => {
  const noBaseline = evaluateAssetSubLane({
    active: SHIPPED,
    unblurred: UNBLURRED,
    activeVariant: "TYCHO_T5_DIFFUSE",
    chromaControl: CHROMA_CONTROL_OK,
  });
  assert.equal(noBaseline.pass, false);
  assert.ok(noBaseline.structural.some((s) => s.includes("RATIO")));
});

// ===========================================================================
// 7. SPLIT + CATALOGUE — DR-01's seam and the supply it moved stars onto.
// ===========================================================================

test("the split sub-lane passes on the shipped seam and its positive control", () => {
  const r = evaluateSplitSubLane(SPLIT_OK);
  assert.equal(r.pass, true);
  assert.equal(r.criteria.split_diffuseFaces_resolvedSources_le_2, true);
  assert.equal(r.criteria.split_unblurredFaces_resolvedSources_ge_bound, true);
  assert.equal(r.criteria.split_liveCubemapOnly_resolvedSources_le_2, true);
});

test("a BLACK live frame is STRUCTURAL, not a seam pass", () => {
  const blank = evaluateSplitSubLane({ ...SPLIT_OK, liveLitPixels: 0 });
  assert.equal(blank.pass, false);
  assert.equal(Object.keys(blank.criteria).length, 0);
  assert.ok(blank.structural.some((s) => s.includes("vacuously")));
});

test("MUTANT: a detector that censuses nothing anywhere FAILS its own control", () => {
  // If the un-blurred reversal faces also census 0, "0 resolved sources on the
  // diffuse faces" is the detector talking, not the seam.
  const broken = evaluateSplitSubLane({
    ...SPLIT_OK,
    unblurredMinFaceSources: 0,
  });
  assert.equal(
    broken.criteria.split_unblurredFaces_resolvedSources_ge_bound,
    false,
  );
  assert.equal(broken.pass, false);
});

test("MUTANT: a re-bake that reintroduces resolved stars FAILS the seam", () => {
  const regressed = evaluateSplitSubLane({
    ...SPLIT_OK,
    diffuseMaxFaceSources: 3,
  });
  assert.equal(
    regressed.criteria.split_diffuseFaces_resolvedSources_le_2,
    false,
  );
  assert.ok(DR01_LIVE_MAX_RESOLVED_SOURCES === 2);
  assert.equal(DR01_LIMITS.diffuseMaxPointSources, 0);
});

test("the catalogue sub-lane binds the SHIPPED depth as an anti-regression floor", () => {
  assert.equal(CATALOGUE_MIN_RECORDS, 2868);
  assert.equal(CATALOGUE_MIN_LIMITING_MAGNITUDE, 5.5);
  const ok = evaluateCatalogueSubLane(CATALOGUE_OK);
  assert.equal(ok.pass, true);
  const shallow = evaluateCatalogueSubLane({ ...CATALOGUE_OK, records: 263 });
  assert.equal(shallow.criteria.catalogue_records_ge_shipped, false);
  const shorter = evaluateCatalogueSubLane({
    ...CATALOGUE_OK,
    limitingMagnitude: 5.0,
  });
  assert.equal(shorter.criteria.catalogue_limitingMagnitude_ge_shipped, false);
});

test("a catalogue that draws nothing is caught — a table is not a supply", () => {
  const drawsNothing = evaluateCatalogueSubLane({
    ...CATALOGUE_OK,
    liveResolvedSources: 0,
  });
  assert.equal(
    drawsNothing.criteria.catalogue_liveResolvedSources_present,
    false,
  );
  const blank = evaluateCatalogueSubLane({ ...CATALOGUE_OK, liveLitPixels: 0 });
  assert.equal(Object.keys(blank.criteria).length, 0);
  assert.equal(blank.pass, false);
});

// ===========================================================================
// 8. MOTION + THE REVERSAL TRIGGERS.
// ===========================================================================

test("the twinkle bar is 0.2 magnitudes, by the Pogson relation", () => {
  // 0.2 mag is exactly r = 10^(0.2/2.5) = 1.2023; the constant is the rounded
  // 1.20, which is 0.198 mag. The tolerance below is what "rounded" is allowed
  // to mean, so a future edit to 1.5 or 1.05 fails here rather than silently
  // redefining the perceptual anchor.
  assert.ok(
    Math.abs(2.5 * Math.log10(TWINKLE_TRIGGER_PEAK_RATIO) - 0.2) < 0.005,
    `${TWINKLE_TRIGGER_PEAK_RATIO} is not 0.2 mag`,
  );
  assert.ok(Math.abs(TWINKLE_TRIGGER_PEAK_RATIO - Math.pow(10, 0.08)) < 0.005);
});

test("the motion lane reports the trigger and certifies only the control", () => {
  const r = evaluateMotionSubLane(MOTION_OK);
  assert.equal(r.pass, true);
  assert.equal(r.criteria.motion_control_isolatesSubPixelPhase, true);
  const t = r.triggers[REVERSAL_TRIGGER.ALIAS_TWINKLE];
  assert.equal(t.triggered, true, "3.77x is 1.44 mag — well past 0.2");
  assert.ok(Math.abs(t.magnitudes - 2.5 * Math.log10(3.77)) < 1e-9);
  // The trigger is NOT a criterion: firing it must not add a failure.
  assert.equal(Object.keys(r.criteria).length, 1);
});

test("a fired trigger cannot turn the gate red on its own", () => {
  const backend = evaluateG3Backend({
    renderer: "webgl",
    asset: {
      active: {
        ...SHIPPED,
        arcminPerPixel: 1.3,
        arcminPerPixelWorst: 1.3,
        faceSizeMin: 4096,
        medianChroma: 0.3,
        medianDustLaneIQR: 10,
      },
      t3: LEGACY_T3,
      unblurred: UNBLURRED,
      activeVariant: "TYCHO_T5_DIFFUSE",
      chromaControl: CHROMA_CONTROL_OK,
      fingerprint: "abc",
    },
    split: SPLIT_OK,
    catalogue: CATALOGUE_OK,
    adversarial: { t3: LEGACY_T3 },
    motion: MOTION_OK,
  });
  assert.equal(
    backend.triggers[REVERSAL_TRIGGER.ALIAS_TWINKLE].triggered,
    true,
    "the trigger fired",
  );
  assert.equal(backend.pass, true, "and the gate is still green");
});

test("MUTANT: peak and sum swinging together is NOT sub-pixel aliasing", () => {
  const global = evaluateMotionSubLane({
    ...MOTION_OK,
    faintPeakRatio: 2.0,
    faintSumRatio: 2.0,
  });
  assert.equal(global.criteria.motion_control_isolatesSubPixelPhase, false);
  assert.equal(global.pass, false);
});

test("a sweep that never moved is STRUCTURAL", () => {
  assert.equal(MOTION_MIN_CHANGED_PIXELS, 1);
  const still = evaluateMotionSubLane({ ...MOTION_OK, changedPixels: 0 });
  assert.equal(Object.keys(still.criteria).length, 0);
  assert.equal(still.pass, false);
  assert.ok(still.structural.some((s) => s.includes("did not actually move")));
});

test("a sweep with no faint target is STRUCTURAL, not a clean twinkle sheet", () => {
  const noTarget = evaluateMotionSubLane({ ...MOTION_OK, faintFound: false });
  assert.equal(noTarget.pass, false);
  assert.equal(Object.keys(noTarget.triggers).length, 0);
});

test("computeAssetTriggers measures the smear and density triggers from the shipped numbers", () => {
  const t = computeAssetTriggers({
    active: SHIPPED,
    unblurred: UNBLURRED,
    t3: LEGACY_T3,
    catalogueRecords: 2868,
  });
  const smear = t[REVERSAL_TRIGGER.SMEARED_MILKY_WAY];
  // Retention 1.488/1.603 = 0.928 against the SHIPPED 0.60 bound: the low-pass
  // kept the degree-scale structure. Grain retention is 0.12 — removed, which is
  // the seam working as designed rather than a smear.
  assert.ok(smear.measured > DR01_LIMITS.diffuseMinBandRatio);
  assert.equal(smear.triggered, false);
  assert.ok(smear.granularityRatio < 0.25);

  const density = t[REVERSAL_TRIGGER.SPRITE_DENSITY];
  assert.ok(
    Math.abs(
      density.deliveredSourcesPerSteradian - 2868 / STERADIANS_FULL_SKY,
    ) < 1e-9,
  );
  assert.equal(density.bound, G3_MIN_SOURCE_DENSITY_RATIO);
  assert.equal(density.triggered, true, "228/sr against t3's 1311/sr");
  assert.ok(density.measured < 1.0);
});

test("computeAssetTriggers survives a structural input instead of throwing", () => {
  // The trigger block is printed even when a sub-lane went structural, so it
  // runs on inputs the asset sub-lane already refused. NaN readings, not a
  // thrown probe.
  const t = computeAssetTriggers({ catalogueRecords: 2868 });
  assert.ok(Number.isNaN(t[REVERSAL_TRIGGER.SMEARED_MILKY_WAY].measured));
  assert.ok(Number.isNaN(t[REVERSAL_TRIGGER.SPRITE_DENSITY].measured));
  // A trigger that cannot be measured must read as TRIGGERED rather than
  // silently clean — an unmeasurable reversal condition is not a cleared one.
  assert.equal(t[REVERSAL_TRIGGER.SMEARED_MILKY_WAY].triggered, true);
  assert.equal(t[REVERSAL_TRIGGER.SPRITE_DENSITY].triggered, true);
});

test("MUTANT: a low-pass that flattened the band FIRES the smear trigger", () => {
  const flattened = { ...SHIPPED, medianBandStdDev: 0.4 };
  const t = computeAssetTriggers({
    active: flattened,
    unblurred: UNBLURRED,
    t3: LEGACY_T3,
    catalogueRecords: 2868,
  });
  assert.equal(t[REVERSAL_TRIGGER.SMEARED_MILKY_WAY].triggered, true);
});

// ===========================================================================
// 9. COMPOSITION — vacuity, precedence, and both-backends.
// ===========================================================================

function passingBackend(renderer, overrides = {}) {
  return evaluateG3Backend({
    renderer,
    asset: {
      active: {
        ...SHIPPED,
        arcminPerPixel: 1.3,
        arcminPerPixelWorst: 1.3,
        faceSizeMin: 4096,
        medianChroma: 0.3,
        medianDustLaneIQR: 10,
      },
      t3: LEGACY_T3,
      unblurred: UNBLURRED,
      activeVariant: "TYCHO_T5_DIFFUSE",
      chromaControl: CHROMA_CONTROL_OK,
      fingerprint: "fp-identical",
    },
    split: SPLIT_OK,
    catalogue: CATALOGUE_OK,
    adversarial: { t3: LEGACY_T3 },
    motion: MOTION_OK,
    ...overrides,
  });
}

test("an EMPTY criteria set is not a pass", () => {
  const allStructural = evaluateG3Backend({
    renderer: "webgl",
    asset: {},
    split: {},
    catalogue: {},
    adversarial: {},
    motion: {},
  });
  assert.equal(Object.keys(allStructural.criteria).length, 0);
  assert.equal(allStructural.pass, false);
  const folded = foldG3Verdict({ webgl: allStructural, webgpu: allStructural });
  assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
  assert.notEqual(folded.exitCode, EXIT_CODE.PASS);
});

test("a criterion failure OUTRANKS a structural leg", () => {
  const failing = passingBackend("webgl", {
    split: { ...SPLIT_OK, diffuseMaxFaceSources: 9 },
  });
  const structuralOnly = evaluateG3Backend({
    renderer: "webgpu",
    asset: {},
    split: {},
    catalogue: {},
    adversarial: {},
    motion: {},
  });
  const folded = foldG3Verdict({ webgl: failing, webgpu: structuralOnly });
  assert.equal(folded.exitCode, EXIT_CODE.FAIL);
  assert.ok(folded.failures.some((f) => f.startsWith("webgl:")));
  assert.ok(folded.structural.length > 0, "the structural notes still travel");
});

test("a pass on ONE backend is a FAIL for the gate (principle 5)", () => {
  const good = passingBackend("webgl");
  const bad = passingBackend("webgpu", {
    catalogue: { ...CATALOGUE_OK, records: 263 },
  });
  const folded = foldG3Verdict({ webgl: good, webgpu: bad });
  assert.equal(folded.exitCode, EXIT_CODE.FAIL);
  assert.ok(
    folded.failures.some((f) => f === "webgpu:catalogue_records_ge_shipped"),
  );
});

test("both backends green is a PASS", () => {
  const folded = foldG3Verdict({
    webgl: passingBackend("webgl"),
    webgpu: passingBackend("webgpu"),
  });
  assert.equal(folded.exitCode, EXIT_CODE.PASS);
  assert.equal(folded.failures.length, 0);
  assert.equal(folded.structural.length, 0);
});

test("a differing ASSET FINGERPRINT is a cross-backend FAIL", () => {
  const gl = passingBackend("webgl");
  const gpu = passingBackend("webgpu");
  gpu.assetFingerprint = "fp-different";
  const folded = foldG3Verdict({ webgl: gl, webgpu: gpu });
  assert.equal(folded.exitCode, EXIT_CODE.FAIL);
  assert.ok(
    folded.failures.some((f) => f.includes("asset_fingerprint_identical")),
  );
});

test("a backend-DEPENDENT reversal trigger is a cross-backend FAIL", () => {
  const gl = passingBackend("webgl");
  const gpu = passingBackend("webgpu", {
    motion: { ...MOTION_OK, faintPeakRatio: 1.05, faintSumRatio: 1.01 },
  });
  const folded = foldG3Verdict({ webgl: gl, webgpu: gpu });
  assert.equal(folded.exitCode, EXIT_CODE.FAIL);
  assert.ok(
    folded.failures.some((f) =>
      f.includes(`reversalTrigger_${REVERSAL_TRIGGER.ALIAS_TWINKLE}_agrees`),
    ),
  );
});

test("an absent backend is STRUCTURAL, never a pass", () => {
  const folded = foldG3Verdict({ webgl: passingBackend("webgl") });
  assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
  assert.ok(folded.structural.some((s) => s.includes("lane absent")));
});

test("the summary carries every bound WITH its kind", () => {
  const summary = buildG3Summary({
    verdict: "FAIL",
    exitCode: EXIT_CODE.FAIL,
    failures: ["webgl:asset_arcminPerPixel_le_2_0"],
    structural: [],
    backends: {
      webgl: passingBackend("webgl"),
      webgpu: passingBackend("webgpu"),
    },
  });
  assert.equal(summary.gate, "G3");
  assert.equal(summary.bounds.RATIFIED.G3_MAX_ARCMIN_PER_PIXEL, 2.0);
  assert.equal(summary.bounds.SHIPPED.CATALOGUE_MIN_RECORDS, 2868);
  assert.equal(
    summary.bounds.DERIVED.TWINKLE_TRIGGER_PEAK_RATIO,
    TWINKLE_TRIGGER_PEAK_RATIO,
  );
  assert.ok(summary.backends.webgl.triggers);
});

// ===========================================================================
// 10. MUTATION-FOLD — remove a fold arm from a COPY of the module and require
//     the failure it catches to come back.
// ===========================================================================

test("MUTATION: deleting the cross-backend arms lets a real defect through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g3-mutant-"));
  try {
    const source = readFileSync(resolve(ROOT, LIB_REL), "utf8");
    const marker = "  const gl = evaluated?.webgl;";
    assert.ok(
      source.includes(marker),
      "the cross-backend block moved; this mutation no longer targets it",
    );
    const cut = source.indexOf(marker);
    const end = source.indexOf('  let verdict = "PASS";', cut);
    assert.ok(end > cut, "could not bound the cross-backend block");
    const mutated = source.slice(0, cut) + source.slice(end);
    const file = join(dir, "mutant.mjs");
    // The copy still imports its siblings by relative path, so it is written
    // next to nothing and given an absolute import base instead.
    await writeFile(
      file,
      mutated
        .replaceAll(
          './"',
          `${pathToFileURL(resolve(ROOT, "Tools/visual-regression/lib/")).href}/"`,
        )
        .replace(
          '"../../skybox-bake/starmap-census.mjs"',
          `"${pathToFileURL(resolve(ROOT, "Tools/skybox-bake/starmap-census.mjs")).href}"`,
        )
        .replace(
          '"./celestial-metrics.mjs"',
          `"${pathToFileURL(resolve(ROOT, "Tools/visual-regression/lib/celestial-metrics.mjs")).href}"`,
        ),
      "utf8",
    );
    const mutant = await import(pathToFileURL(file).href);
    const gl = passingBackend("webgl");
    const gpu = passingBackend("webgpu");
    gpu.assetFingerprint = "fp-different";
    // The REAL module reds this; the mutant must green it, which is the proof
    // the arm is load-bearing rather than decorative.
    assert.equal(
      foldG3Verdict({ webgl: gl, webgpu: gpu }).exitCode,
      EXIT_CODE.FAIL,
    );
    assert.equal(
      mutant.foldG3Verdict({ webgl: gl, webgpu: gpu }).exitCode,
      EXIT_CODE.PASS,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 11. SOURCE-TEXT TRIPWIRES.
// ===========================================================================

test("the census floor may not be re-tuned by any G3 caller", () => {
  // Same prohibition the G1 spec carries (Batch 848 /
  // PROBE-CELESTIAL-GATES-PRE-DR01-STAR-THRESHOLDS), extended to this lane's
  // files: lowering the floor puts candidates back inside the diffuse band's own
  // 8-bit range and re-creates the brightness count the census replaced.
  for (const rel of [LIB_REL, PROBE_REL]) {
    const src = readNormalized(rel);
    for (const option of ["threshold", "peakRatio", "minPeak", "minContrast"]) {
      assert.doesNotMatch(
        src,
        new RegExp(String.raw`\b${option}\s*:\s*[0-9(]`),
        `${rel} passes a ${option} override — the census floor may not be re-tuned`,
      );
    }
  }
});

test("the probe registers --g3, writes its own report, and routes STRUCTURAL to exit 3", () => {
  assert.match(PROBE, /const G3 = process\.argv\.includes\("--g3"\);/);
  assert.match(PROBE, /"celestial-g3\.json"/);
  assert.match(PROBE, /await runG3\(browser, git\)/);
  // Exit-code contract: STRUCTURAL must never be reported as ERROR(2) or PASS(0).
  assert.equal(EXIT_CODE.STRUCTURAL, 3);
  assert.match(PROBE, /\[EXIT_CODE\.STRUCTURAL\]:\s*\n?\s*"G3 STRUCTURAL/);
});

test("the probe prints the reversal triggers SEPARATELY and labelled non-certifying", () => {
  // A reader who mistakes a fired trigger for a gate failure — or an unfired one
  // for a pass — would draw a DR-01 conclusion the gate never made.
  assert.match(PROBE, /DR-01 REVERSAL TRIGGERS \(measured; NON-CERTIFYING\)/);
});

test("the G3 motion sweep obeys the pinned-clock and same-task rules", () => {
  const sweep = PROBE.slice(
    PROBE.indexOf("async function g3MotionSweep"),
    PROBE.indexOf("function g3MotionMetrics"),
  );
  assert.ok(sweep.length > 0, "the motion sweep moved");
  assert.doesNotMatch(
    sweep,
    /scene\.render\(\s*\)/,
    "a bare scene.render() renders at WALL CLOCK, not the pinned time",
  );
  assert.match(sweep, /scene\.render\(pinnedTime\(\)\)/);
  // Interleaved A/B: the OFF and ON renders live in the same loop iteration.
  assert.match(
    sweep,
    /starField\.show = false;[\s\S]{0,400}starField\.show = true;/,
  );
  // The measured render and its readback must not be separated by an await.
  const measured = sweep.slice(sweep.indexOf("const t1 = performance.now();"));
  const between = measured.slice(0, measured.indexOf("const img = grab();"));
  assert.doesNotMatch(
    between,
    /await /,
    "an await split the render from the grab",
  );
});

test("the probe's G3 asset arm reads the URLs the ENGINE resolved", () => {
  // String surgery on a filename prefix would measure whatever the probe
  // believes ships, not what the engine loads.
  assert.match(PROBE, /C\.SkyBox\.createEarthSkyBox\(v\)\.sources/);
  assert.match(PROBE, /scene\.skyBox\.variant/);
});

test("the recorded derivation matches the ratios it reports", () => {
  const d = BUNDLED_ASSET_DERIVATION;
  const check = (a, b, recorded) =>
    assert.ok(
      Math.abs(a / b - recorded) / recorded < 0.01,
      `recorded ratio ${recorded} disagrees with ${a}/${b}`,
    );
  check(
    d.t5diffuse.medianDustLaneIQR,
    d.t3.medianDustLaneIQR,
    d.ratios.dustLaneIQR_t5diffuse_over_t3,
  );
  check(
    d.t5.medianDustLaneIQR,
    d.t3.medianDustLaneIQR,
    d.ratios.dustLaneIQR_t5_over_t3,
  );
  check(
    d.t5diffuse.medianGranularityIQR,
    d.t5.medianGranularityIQR,
    d.ratios.granularityIQR_t5diffuse_over_t5,
  );
  check(
    d.t5.sourcesPerSteradian,
    d.t3.sourcesPerSteradian,
    d.ratios.sourcesPerSteradian_t5_over_t3,
  );
  check(
    CATALOGUE_MIN_RECORDS / STERADIANS_FULL_SKY,
    d.t3.sourcesPerSteradian,
    d.ratios.sourcesPerSteradian_catalogue_over_t3,
  );
});
