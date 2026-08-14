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
import { builtinModules } from "node:module";
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
  G3_CERTIFICATION_FACE_SIZE_PX,
  G3_CERTIFICATION_RESOLUTION,
  G3_CERTIFICATION_VARIANT,
  G3_CERTIFICATION_VRAM_BYTES,
  G3_ACTIVE_SOURCE_FINGERPRINT_SCHEMA,
  G3_CUBE_FACE_COUNT,
  G3_CUBE_FACE_KEYS,
  G3_EXPECTED_DEFAULT_RESOLUTION,
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
  canonicalG3ActiveSourceFingerprintPayload,
  computeAssetTriggers,
  computeG3ActiveSourceFingerprint,
  degreesPerPixel,
  dustLaneStructure,
  evaluateAdversarialSubLane,
  evaluateAssetSourceSubLane,
  evaluateAssetSubLane,
  evaluateCatalogueSubLane,
  evaluateG3Backend,
  evaluateG3SourcePreflight,
  evaluateMotionSubLane,
  evaluateSplitSubLane,
  foldG3Verdict,
  foldVariant,
  granularityIQR,
  jpegChromaSubsampling,
  lowPass,
  luminanceStrided,
} from "./lib/celestial-g3-gate.mjs";
import { replaceOwnedResourceTransaction } from "./lib/owned-resource-transaction.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const readNormalized = (relative) =>
  readFileSync(resolve(ROOT, relative), "utf8").replaceAll("\r\n", "\n");
const PROBE_REL = "Tools/visual-regression/probe-celestial-gates.mjs";
const LIB_REL = "Tools/visual-regression/lib/celestial-g3-gate.mjs";
const OWNED_RESOURCE_HELPER_REL =
  "Tools/visual-regression/lib/owned-resource-transaction.mjs";
const OWNED_RESOURCE_HELPER_URL = `/${OWNED_RESOURCE_HELPER_REL}`;
const PROBE = readNormalized(PROBE_REL);
const ASSET_DIR = "packages/engine/Source/Assets/Textures/SkyBox";
const FACES = ["px", "mx", "py", "my", "pz", "mz"];
const NODE_BUILTIN_SPECIFIERS = new Set(
  builtinModules.flatMap((specifier) => [
    specifier,
    specifier.startsWith("node:") ? specifier : `node:${specifier}`,
  ]),
);

function literalModuleSpecifiers(source) {
  return [
    ...source.matchAll(
      /\b(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/gu,
    ),
  ].map((match) => match[1]);
}

function assertBrowserSafeModuleGraph(
  entryRelativePath,
  readSource = readFileSync,
) {
  const pending = [resolve(ROOT, entryRelativePath)];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const source = readSource(file, "utf8").replaceAll("\r\n", "\n");
    for (const specifier of literalModuleSpecifiers(source)) {
      const bareRoot = specifier.replace(/^node:/u, "").split("/")[0];
      assert.equal(
        specifier.startsWith("node:") ||
          NODE_BUILTIN_SPECIFIERS.has(specifier) ||
          NODE_BUILTIN_SPECIFIERS.has(bareRoot),
        false,
        `${file} imports the Node built-in ${specifier}`,
      );
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        pending.push(resolve(dirname(file), specifier));
      } else if (specifier.startsWith("/")) {
        pending.push(resolve(ROOT, specifier.slice(1)));
      } else {
        assert.fail(`${file} has browser-unsafe bare import ${specifier}`);
      }
    }
  }
  return visited;
}

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

const SOURCE_KEYS = Object.freeze({
  px: "positiveX",
  mx: "negativeX",
  py: "positiveY",
  my: "negativeY",
  pz: "positiveZ",
  mz: "negativeZ",
});
const ACTIVE_SOURCES = Object.freeze(
  Object.fromEntries(
    G3_CUBE_FACE_KEYS.map((faceKey) => [
      SOURCE_KEYS[faceKey],
      `/Assets/g3-4096-${faceKey}.jpg`,
    ]),
  ),
);
const DEFAULT_CUBE_VRAM_BYTES = G3_CUBE_FACE_COUNT * 2048 * 2048 * 4;
const exactFaceProof = (
  size = G3_CERTIFICATION_FACE_SIZE_PX,
  sources = ACTIVE_SOURCES,
) =>
  Object.fromEntries(
    G3_CUBE_FACE_KEYS.map((faceKey) => {
      const sourceKey = SOURCE_KEYS[faceKey];
      return [
        faceKey,
        {
          sourceKey,
          url: sources[sourceKey],
          sha256: "a".repeat(64),
          bytes: 1024,
          decodedWidth: size,
          decodedHeight: size,
        },
      ];
    }),
  );

const activeFingerprintInput = (proof, faceOrder = G3_CUBE_FACE_KEYS) => ({
  resolvedVariant: proof.resolvedVariant,
  resolvedResolution: proof.resolvedResolution,
  resolvedFaceSize: proof.resolvedFaceSize,
  records: faceOrder.map((faceKey) => ({
    faceKey,
    sourceKey: proof.faces[faceKey].sourceKey,
    url: proof.faces[faceKey].url,
    sha256: proof.faces[faceKey].sha256,
    decodedWidth: proof.faces[faceKey].decodedWidth,
    decodedHeight: proof.faces[faceKey].decodedHeight,
  })),
});

const ACTIVE_SOURCE_PROOF_BASE = {
  requestedVariant: G3_CERTIFICATION_VARIANT,
  requestedResolution: G3_CERTIFICATION_RESOLUTION,
  defaultResolution: G3_EXPECTED_DEFAULT_RESOLUTION,
  maximumCubeMapSize: 8192,
  resolvedVariant: G3_CERTIFICATION_VARIANT,
  resolvedResolution: G3_CERTIFICATION_RESOLUTION,
  resolvedFaceSize: G3_CERTIFICATION_FACE_SIZE_PX,
  resolvedEstimatedVramBytes: G3_CERTIFICATION_VRAM_BYTES,
  previousSkyBoxPresent: true,
  previousSkyBoxResident: true,
  previousResolution: G3_EXPECTED_DEFAULT_RESOLUTION,
  previousFaceSize: 2048,
  previousEstimatedVramBytes: DEFAULT_CUBE_VRAM_BYTES,
  previousResidentEstimatedVramBytes: DEFAULT_CUBE_VRAM_BYTES,
  replacementInstalled: true,
  previousSkyBoxDestroyed: true,
  candidateSkyBoxDestroyed: false,
  replacementHadRenderOverlap: false,
  currentEstimatedVramBytes: G3_CERTIFICATION_VRAM_BYTES,
  peakEstimatedVramBytes: G3_CERTIFICATION_VRAM_BYTES,
  activeSourceCount: G3_CUBE_FACE_COUNT,
  fetchedSourceCount: G3_CUBE_FACE_COUNT,
  decodedFaceCount: G3_CUBE_FACE_COUNT,
  decodedFaceSizeMin: G3_CERTIFICATION_FACE_SIZE_PX,
  fetchedSourcesMatchEnvironmentActiveSources: true,
  activeSources: ACTIVE_SOURCES,
  faces: exactFaceProof(),
};
const ACTIVE_SOURCE_PROOF_OK = Object.freeze({
  ...ACTIVE_SOURCE_PROOF_BASE,
  fingerprintSha256: computeG3ActiveSourceFingerprint(
    activeFingerprintInput(ACTIVE_SOURCE_PROOF_BASE),
  ),
});

/** A motion record that satisfies every structural guard. */
const MOTION_OK = Object.freeze({
  changedPixels: 91234,
  faintFound: true,
  brightFound: true,
  faintPeakRatio: 3.77,
  faintSumRatio: 1.226,
  brightSumRatio: 1.01,
  frames: 24,
  basisEvidence: {
    coordinateSpace: "WC",
    projectionBasis: "post-Camera.setView",
    samples: Array.from({ length: 24 }, (_, k) => ({
      k,
      requestedDirection: { x: 1, y: 0, z: 0 },
      requestedRight: { x: 0, y: 1, z: 0 },
      requestedUp: { x: 0, y: 0, z: 1 },
      appliedDirectionWC: { x: 1, y: 0, z: 0 },
      appliedRightWC: { x: 0, y: 1, z: 0 },
      appliedUpWC: { x: 0, y: 0, z: 1 },
      directionResidualDeg: 0,
      rightResidualDeg: 0,
      upResidualDeg: 0,
      appliedMaxAbsDot: 0,
      brightProjectionBasis: "applied-WC",
      faintProjectionBasis: "applied-WC",
    })),
    maxRequestedAppliedResidualDeg: { direction: 0, right: 0, up: 0 },
    maxAppliedAbsDot: 0,
  },
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

test("sky-box replacement destroys the old owner once after installation", () => {
  const events = [];
  const oldBox = { name: "old" };
  const newBox = { name: "new" };
  let owner = oldBox;
  const destroyed = new Map();
  const result = replaceOwnedResourceTransaction({
    current: oldBox,
    create: () => {
      events.push("create:new");
      return newBox;
    },
    install: (candidate) => {
      events.push(`install:${candidate.name}`);
      owner = candidate;
    },
    restore: (previous) => {
      events.push(`restore:${previous.name}`);
      owner = previous;
    },
    destroy: (resource) => {
      events.push(`destroy:${resource.name}`);
      destroyed.set(resource, (destroyed.get(resource) ?? 0) + 1);
    },
  });
  assert.deepEqual(events, ["create:new", "install:new", "destroy:old"]);
  assert.equal(owner, newBox);
  assert.equal(destroyed.get(oldBox), 1);
  assert.equal(destroyed.get(newBox), undefined);
  assert.deepEqual(result, {
    resource: newBox,
    installed: true,
    previousDestroyed: true,
    candidateDestroyed: false,
  });
});

test("an installation failure restores the old owner and destroys only the candidate", () => {
  const events = [];
  const oldBox = { name: "old" };
  const newBox = { name: "new" };
  let owner = oldBox;
  assert.throws(
    () =>
      replaceOwnedResourceTransaction({
        current: oldBox,
        create: () => {
          events.push("create:new");
          return newBox;
        },
        install: (candidate) => {
          events.push(`install:${candidate.name}`);
          owner = candidate;
          throw new Error("install failed");
        },
        restore: (previous) => {
          events.push(`restore:${previous.name}`);
          owner = previous;
        },
        destroy: (resource) => events.push(`destroy:${resource.name}`),
      }),
    /install failed/,
  );
  assert.equal(owner, oldBox);
  assert.deepEqual(events, [
    "create:new",
    "install:new",
    "restore:old",
    "destroy:new",
  ]);
  assert.doesNotMatch(events.join(" "), /destroy:old/);
});

test("a rollback failure never destroys the possibly-installed candidate", () => {
  const oldBox = { name: "old" };
  const newBox = { name: "new" };
  let owner = oldBox;
  let destroyCalls = 0;
  assert.throws(
    () =>
      replaceOwnedResourceTransaction({
        current: oldBox,
        create: () => newBox,
        install: (candidate) => {
          owner = candidate;
          throw new Error("install failed");
        },
        restore: () => {
          throw new Error("restore failed");
        },
        destroy: () => {
          destroyCalls++;
        },
      }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.cause?.message === "install failed",
  );
  assert.equal(owner, newBox);
  assert.equal(destroyCalls, 0);
});

test("a factory failure cannot mutate ownership or destroy either resource", () => {
  const events = [];
  const oldBox = { name: "old" };
  assert.throws(
    () =>
      replaceOwnedResourceTransaction({
        current: oldBox,
        create: () => {
          events.push("create");
          throw new Error("create failed");
        },
        install: () => events.push("install"),
        restore: () => events.push("restore"),
        destroy: () => events.push("destroy"),
      }),
    /create failed/,
  );
  assert.deepEqual(events, ["create"]);
});

test("an old-owner destroy failure keeps the installed candidate owned", () => {
  const oldBox = { name: "old" };
  const newBox = { name: "new" };
  let owner = oldBox;
  let oldDestroyCalls = 0;
  let candidateDestroyCalls = 0;
  assert.throws(
    () =>
      replaceOwnedResourceTransaction({
        current: oldBox,
        create: () => newBox,
        install: (candidate) => {
          owner = candidate;
        },
        restore: (previous) => {
          owner = previous;
        },
        destroy: (resource) => {
          if (resource === oldBox) {
            oldDestroyCalls++;
            throw new Error("old destroy failed");
          }
          candidateDestroyCalls++;
        },
      }),
    /old destroy failed/,
  );
  assert.equal(owner, newBox);
  assert.equal(oldDestroyCalls, 1);
  assert.equal(candidateDestroyCalls, 0);
});

test("the cheap G3 preflight proves exact reachability before pixel work", () => {
  const r = evaluateG3SourcePreflight(ACTIVE_SOURCE_PROOF_OK);
  assert.equal(r.pass, true);
  assert.deepEqual(r.criteria, {
    assetSource_preflightExact4096Reachable: true,
  });
});

test("MUTANT: runtime policy, device, lifecycle, and residency lies are STRUCTURAL", () => {
  const { px: omittedFace, ...fiveFaces } = ACTIVE_SOURCE_PROOF_OK.faces;
  assert.ok(omittedFace);
  const mutants = [
    { defaultResolution: "4096" },
    { maximumCubeMapSize: 2048 },
    { previousSkyBoxResident: false },
    { previousResolution: "1024" },
    { previousSkyBoxDestroyed: false },
    { candidateSkyBoxDestroyed: true },
    { replacementHadRenderOverlap: true },
    { currentEstimatedVramBytes: DEFAULT_CUBE_VRAM_BYTES },
    {
      peakEstimatedVramBytes:
        G3_CERTIFICATION_VRAM_BYTES + DEFAULT_CUBE_VRAM_BYTES,
    },
    { activeSources: { ...ACTIVE_SOURCES, extra: "/not-a-face.jpg" } },
    {
      faces: {
        ...ACTIVE_SOURCE_PROOF_OK.faces,
        extra: ACTIVE_SOURCE_PROOF_OK.faces.px,
      },
    },
    {
      faces: {
        ...fiveFaces,
        extra: ACTIVE_SOURCE_PROOF_OK.faces.px,
      },
    },
    {
      faces: {
        ...ACTIVE_SOURCE_PROOF_OK.faces,
        px: {
          ...ACTIVE_SOURCE_PROOF_OK.faces.px,
          sourceKey: "negativeX",
        },
      },
    },
  ];
  for (const mutant of mutants) {
    const r = evaluateG3SourcePreflight({
      ...ACTIVE_SOURCE_PROOF_OK,
      ...mutant,
    });
    assert.equal(r.pass, false, JSON.stringify(mutant));
    assert.equal(Object.keys(r.criteria).length, 0);
  }
});

test("the G3 source proof binds the explicit diffuse 4096 active source set", () => {
  const r = evaluateAssetSourceSubLane(ACTIVE_SOURCE_PROOF_OK);
  assert.equal(r.pass, true);
  assert.deepEqual(r.criteria, {
    assetSource_exactActive4096SourceSet_proven: true,
  });
  assert.equal(
    r.measured.recomputedFingerprintSha256,
    ACTIVE_SOURCE_PROOF_OK.fingerprintSha256,
  );
});

test("the active-source aggregate has one versioned, ordered canonical payload", () => {
  const input = activeFingerprintInput(ACTIVE_SOURCE_PROOF_OK);
  const payload = canonicalG3ActiveSourceFingerprintPayload(input);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.schema, G3_ACTIVE_SOURCE_FINGERPRINT_SCHEMA);
  assert.deepEqual(
    parsed.faces.map((face) => face.faceKey),
    G3_CUBE_FACE_KEYS,
  );
  assert.equal(
    computeG3ActiveSourceFingerprint(input),
    ACTIVE_SOURCE_PROOF_OK.fingerprintSha256,
  );
});

test("MUTANT: stale or constant-looking aggregate fingerprints are STRUCTURAL", () => {
  for (const fingerprintSha256 of ["0".repeat(64), "a".repeat(64)]) {
    const r = evaluateAssetSourceSubLane({
      ...ACTIVE_SOURCE_PROOF_OK,
      fingerprintSha256,
    });
    assert.equal(r.pass, false, fingerprintSha256);
    assert.ok(r.structural.some((s) => s.includes("recomputed ordered")));
  }
});

test("MUTANT: face order is part of the active-source aggregate", () => {
  const wrongOrder = [...G3_CUBE_FACE_KEYS];
  [wrongOrder[0], wrongOrder[1]] = [wrongOrder[1], wrongOrder[0]];
  const fingerprintSha256 = computeG3ActiveSourceFingerprint(
    activeFingerprintInput(ACTIVE_SOURCE_PROOF_OK, wrongOrder),
  );
  assert.notEqual(fingerprintSha256, ACTIVE_SOURCE_PROOF_OK.fingerprintSha256);
  const r = evaluateAssetSourceSubLane({
    ...ACTIVE_SOURCE_PROOF_OK,
    fingerprintSha256,
  });
  assert.equal(r.pass, false);
  assert.ok(r.structural.some((s) => s.includes("recomputed ordered")));
});

test("MUTANT: a retained face hash change invalidates a stale aggregate", () => {
  const faces = {
    ...ACTIVE_SOURCE_PROOF_OK.faces,
    px: { ...ACTIVE_SOURCE_PROOF_OK.faces.px, sha256: "b".repeat(64) },
  };
  const r = evaluateAssetSourceSubLane({
    ...ACTIVE_SOURCE_PROOF_OK,
    faces,
  });
  assert.equal(r.pass, false);
  assert.notEqual(
    r.measured.recomputedFingerprintSha256,
    ACTIVE_SOURCE_PROOF_OK.fingerprintSha256,
  );
  assert.ok(r.structural.some((s) => s.includes("recomputed ordered")));
});

test("MUTANT: a 4096 request that falls back to 2048 is STRUCTURAL", () => {
  const fallback = evaluateAssetSourceSubLane({
    ...ACTIVE_SOURCE_PROOF_OK,
    resolvedResolution: "2048",
    resolvedFaceSize: 2048,
    decodedFaceSizeMin: 2048,
  });
  assert.equal(fallback.pass, false);
  assert.equal(Object.keys(fallback.criteria).length, 0);
  assert.ok(fallback.structural.some((s) => s.includes("not available")));
});

test("MUTANT: decoding a default-variant source set cannot prove the live asset", () => {
  const wrongSources = evaluateAssetSourceSubLane({
    ...ACTIVE_SOURCE_PROOF_OK,
    fetchedSourcesMatchEnvironmentActiveSources: false,
  });
  assert.equal(wrongSources.pass, false);
  assert.ok(
    wrongSources.structural.some((s) =>
      s.includes("environment.activeSources"),
    ),
  );
});

test("MUTANT: an incomplete or unhashed active cube cannot certify", () => {
  const incomplete = evaluateAssetSourceSubLane({
    ...ACTIVE_SOURCE_PROOF_OK,
    fetchedSourceCount: 5,
    fingerprintSha256: "not-a-digest",
  });
  assert.equal(incomplete.pass, false);
  assert.ok(incomplete.structural.some((s) => s.includes("face counts")));
  assert.ok(incomplete.structural.some((s) => s.includes("SHA-256")));
});

test("MUTANT: every face must independently decode square at exactly 4096", () => {
  for (const faceKey of G3_CUBE_FACE_KEYS) {
    const badFaces = {
      ...ACTIVE_SOURCE_PROOF_OK.faces,
      [faceKey]: {
        ...ACTIVE_SOURCE_PROOF_OK.faces[faceKey],
        decodedHeight: 2048,
      },
    };
    const r = evaluateAssetSourceSubLane({
      ...ACTIVE_SOURCE_PROOF_OK,
      faces: badFaces,
    });
    assert.equal(r.pass, false, faceKey);
    assert.ok(r.structural.some((s) => s.includes("decode square")));
  }
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
      sourceProof: ACTIVE_SOURCE_PROOF_OK,
      chromaControl: CHROMA_CONTROL_OK,
      fingerprint: ACTIVE_SOURCE_PROOF_OK.fingerprintSha256,
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

test("MUTANT: requested-basis records cannot stand in for post-setView WC basis", () => {
  const requestedOnly = MOTION_OK.basisEvidence.samples.map((sample, i) =>
    i === 0
      ? {
          k: sample.k,
          requestedDirection: sample.appliedDirectionWC,
          requestedRight: sample.appliedRightWC,
          requestedUp: sample.appliedUpWC,
        }
      : sample,
  );
  const r = evaluateMotionSubLane({
    ...MOTION_OK,
    basisEvidence: {
      ...MOTION_OK.basisEvidence,
      samples: requestedOnly,
    },
  });
  assert.equal(r.pass, false);
  assert.equal(Object.keys(r.criteria).length, 0);
  assert.ok(r.structural.some((s) => s.includes("requested/applied")));
});

test("MUTANT: one missing applied-basis record makes the sweep STRUCTURAL", () => {
  const r = evaluateMotionSubLane({
    ...MOTION_OK,
    basisEvidence: {
      ...MOTION_OK.basisEvidence,
      samples: MOTION_OK.basisEvidence.samples.slice(1),
    },
  });
  assert.equal(r.pass, false);
  assert.ok(r.structural.some((s) => s.includes("every frame")));
});

test("MUTANT: changing only the faint projection binding is STRUCTURAL", () => {
  const samples = MOTION_OK.basisEvidence.samples.map((sample, i) =>
    i === 7 ? { ...sample, faintProjectionBasis: "requested" } : sample,
  );
  const r = evaluateMotionSubLane({
    ...MOTION_OK,
    basisEvidence: { ...MOTION_OK.basisEvidence, samples },
  });
  assert.equal(r.pass, false);
  assert.ok(r.structural.some((s) => s.includes("both targets")));
});

test("MUTANT: deleted or null basis residuals are STRUCTURAL", () => {
  const deleted = { ...MOTION_OK.basisEvidence.samples[0] };
  delete deleted.directionResidualDeg;
  const nulled = {
    ...MOTION_OK.basisEvidence.samples[0],
    upResidualDeg: null,
  };
  for (const first of [deleted, nulled]) {
    const r = evaluateMotionSubLane({
      ...MOTION_OK,
      basisEvidence: {
        ...MOTION_OK.basisEvidence,
        samples: [first, ...MOTION_OK.basisEvidence.samples.slice(1)],
      },
    });
    assert.equal(r.pass, false);
    assert.ok(r.structural.some((s) => s.includes("finite residuals")));
  }
});

test("MUTANT: reported basis maxima must equal the sample maxima", () => {
  const r = evaluateMotionSubLane({
    ...MOTION_OK,
    basisEvidence: {
      ...MOTION_OK.basisEvidence,
      maxRequestedAppliedResidualDeg: {
        ...MOTION_OK.basisEvidence.maxRequestedAppliedResidualDeg,
        direction: 1,
      },
    },
  });
  assert.equal(r.pass, false);
  assert.ok(r.structural.some((s) => s.includes("consistent maxima")));
});

test("MUTANT: a 90-degree requested/applied mismatch labelled zero fails", () => {
  const first = {
    ...MOTION_OK.basisEvidence.samples[0],
    appliedDirectionWC: { x: 0, y: 1, z: 0 },
    appliedRightWC: { x: -1, y: 0, z: 0 },
    // The forged record keeps every reported residual at zero even though the
    // independently recomputed direction/right residuals are both 90 degrees.
    directionResidualDeg: 0,
    rightResidualDeg: 0,
    upResidualDeg: 0,
    appliedMaxAbsDot: 0,
  };
  const r = evaluateMotionSubLane({
    ...MOTION_OK,
    basisEvidence: {
      ...MOTION_OK.basisEvidence,
      samples: [first, ...MOTION_OK.basisEvidence.samples.slice(1)],
    },
  });
  assert.equal(r.pass, false);
  assert.ok(r.structural.some((s) => s.includes("recomputed")));
});

test("MUTANT: finite but non-unit applied vectors cannot certify", () => {
  const first = {
    ...MOTION_OK.basisEvidence.samples[0],
    appliedDirectionWC: { x: 2, y: 0, z: 0 },
  };
  const r = evaluateMotionSubLane({
    ...MOTION_OK,
    basisEvidence: {
      ...MOTION_OK.basisEvidence,
      samples: [first, ...MOTION_OK.basisEvidence.samples.slice(1)],
    },
  });
  assert.equal(r.pass, false);
  assert.ok(r.structural.some((s) => s.includes("finite unit")));
});

test("MUTANT: a unit but non-orthogonal applied basis cannot certify", () => {
  const diagonal = Math.SQRT1_2;
  const first = {
    ...MOTION_OK.basisEvidence.samples[0],
    appliedRightWC: { x: diagonal, y: diagonal, z: 0 },
    rightResidualDeg: 45,
    appliedMaxAbsDot: diagonal,
  };
  const r = evaluateMotionSubLane({
    ...MOTION_OK,
    basisEvidence: {
      ...MOTION_OK.basisEvidence,
      samples: [first, ...MOTION_OK.basisEvidence.samples.slice(1)],
      maxRequestedAppliedResidualDeg: {
        direction: 0,
        right: 45,
        up: 0,
      },
      maxAppliedAbsDot: diagonal,
    },
  });
  assert.equal(r.pass, false);
  assert.ok(r.structural.some((s) => s.includes("orthogonal")));
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

function backendFixture(renderer, overrides = {}) {
  const active = {
    ...SHIPPED,
    faceSize: 4096,
    arcminPerPixel: 1.3,
    arcminPerPixelWorst: 1.3,
    faceSizeMin: 4096,
    medianChroma: 0.3,
    medianDustLaneIQR: 10,
  };
  return {
    renderer,
    asset: {
      active,
      t3: LEGACY_T3,
      unblurred: UNBLURRED,
      activeVariant: "TYCHO_T5_DIFFUSE",
      sourceProof: ACTIVE_SOURCE_PROOF_OK,
      chromaControl: CHROMA_CONTROL_OK,
      fingerprint: ACTIVE_SOURCE_PROOF_OK.fingerprintSha256,
    },
    split: SPLIT_OK,
    catalogue: CATALOGUE_OK,
    adversarial: { t3: LEGACY_T3 },
    motion: MOTION_OK,
    triggers: computeAssetTriggers({
      active,
      unblurred: UNBLURRED,
      t3: LEGACY_T3,
      catalogueRecords: CATALOGUE_OK.records,
    }),
    ...overrides,
  };
}

function passingBackend(renderer, overrides = {}) {
  return evaluateG3Backend(backendFixture(renderer, overrides));
}

function independentlyValidChangedFingerprintBackend(renderer) {
  const faces = {
    ...ACTIVE_SOURCE_PROOF_OK.faces,
    px: { ...ACTIVE_SOURCE_PROOF_OK.faces.px, sha256: "b".repeat(64) },
  };
  const changedBase = { ...ACTIVE_SOURCE_PROOF_OK, faces };
  const sourceProof = {
    ...changedBase,
    fingerprintSha256: computeG3ActiveSourceFingerprint(
      activeFingerprintInput(changedBase),
    ),
  };
  const input = backendFixture(renderer);
  return evaluateG3Backend({
    ...input,
    asset: {
      ...input.asset,
      sourceProof,
      fingerprint: sourceProof.fingerprintSha256,
    },
  });
}

const FALLBACK_ACTIVE_SOURCES = Object.freeze(
  Object.fromEntries(
    Object.entries(ACTIVE_SOURCES).map(([key, url]) => [
      key,
      url.replace("4096", "2048"),
    ]),
  ),
);
const FALLBACK_SOURCE_PROOF = Object.freeze({
  ...ACTIVE_SOURCE_PROOF_OK,
  resolvedResolution: "2048",
  resolvedFaceSize: 2048,
  resolvedEstimatedVramBytes: DEFAULT_CUBE_VRAM_BYTES,
  currentEstimatedVramBytes: DEFAULT_CUBE_VRAM_BYTES,
  peakEstimatedVramBytes: DEFAULT_CUBE_VRAM_BYTES,
  decodedFaceSizeMin: 2048,
  activeSources: FALLBACK_ACTIVE_SOURCES,
  faces: exactFaceProof(2048, FALLBACK_ACTIVE_SOURCES),
});

function fallbackBackend(renderer) {
  const input = backendFixture(renderer);
  const adversarialThatWouldFail = {
    ...LEGACY_T3,
    subsampling: "4:4:4",
    arcminPerPixel: 1.3,
    arcminPerPixelWorst: 1.3,
    maxFaceSources: 0,
  };
  return evaluateG3Backend({
    ...input,
    asset: {
      ...input.asset,
      active: SHIPPED,
      sourceProof: FALLBACK_SOURCE_PROOF,
      fingerprint: `fallback-${renderer}`,
    },
    split: {
      ...SPLIT_OK,
      diffuseMaxFaceSources: 99,
      liveResolvedSources: 99,
    },
    catalogue: { ...CATALOGUE_OK, records: 1, liveResolvedSources: 0 },
    adversarial: { t3: adversarialThatWouldFail },
    motion: { ...MOTION_OK, faintPeakRatio: 2, faintSumRatio: 2 },
    triggers: {
      [REVERSAL_TRIGGER.SMEARED_MILKY_WAY]: {
        triggered: renderer === "webgl",
      },
    },
  });
}

function validSourceBadAssetBackend(renderer) {
  const input = backendFixture(renderer);
  return evaluateG3Backend({
    ...input,
    asset: {
      ...input.asset,
      active: {
        ...input.asset.active,
        medianChroma: 0,
        medianDustLaneIQR: 0,
      },
    },
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

test("MUTANT: a full 2048-fallback backend cannot synthesize product failures", () => {
  const fallback = fallbackBackend("webgl");
  assert.equal(fallback.pass, false);
  assert.deepEqual(fallback.criteria, {});
  assert.deepEqual(Object.keys(fallback.subLanes), ["assetSource"]);
  assert.equal(fallback.assetFingerprint, null);
  assert.deepEqual(fallback.triggers, {});
  assert.ok(
    fallback.structural.some(
      (s) => s.includes("assetSource:") && s.includes("2048"),
    ),
  );
});

test("MUTANT: two poisoned 2048-fallback backends fold to STRUCTURAL, not FAIL", () => {
  const folded = foldG3Verdict({
    webgl: fallbackBackend("webgl"),
    webgpu: fallbackBackend("webgpu"),
  });
  assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
  assert.equal(folded.verdict, "STRUCTURAL");
  assert.deepEqual(folded.failures, []);
  assert.ok(folded.structural.some((s) => s.startsWith("webgl:")));
  assert.ok(folded.structural.some((s) => s.startsWith("webgpu:")));
});

test("a valid 4096 source proof exposes genuine bad-asset backend criteria", () => {
  const bad = validSourceBadAssetBackend("webgl");
  assert.equal(bad.subLanes.assetSource.pass, true);
  assert.equal(bad.structural.length, 0);
  assert.equal(bad.criteria.format_medianChroma_ge_0_20, false);
  assert.equal(bad.criteria.fidelity_dustLaneIQR_ratio_ge_3, false);
  assert.equal(bad.pass, false);
});

test("two valid-source bad assets fold to FAIL, not STRUCTURAL", () => {
  const folded = foldG3Verdict({
    webgl: validSourceBadAssetBackend("webgl"),
    webgpu: validSourceBadAssetBackend("webgpu"),
  });
  assert.equal(folded.exitCode, EXIT_CODE.FAIL);
  assert.equal(folded.verdict, "FAIL");
  assert.equal(folded.structural.length, 0);
  assert.ok(folded.failures.includes("webgl:format_medianChroma_ge_0_20"));
  assert.ok(folded.failures.includes("webgpu:format_medianChroma_ge_0_20"));
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

test("MUTANT: a valid-looking stale producer aggregate is STRUCTURAL", () => {
  const input = backendFixture("webgl");
  const stale = evaluateG3Backend({
    ...input,
    asset: { ...input.asset, fingerprint: "0".repeat(64) },
  });
  assert.equal(stale.subLanes.assetSource.pass, true);
  assert.equal(stale.pass, false);
  assert.ok(stale.structural.some((s) => s.includes("producer aggregate")));
  const gpuInput = backendFixture("webgpu");
  const gpuStale = evaluateG3Backend({
    ...gpuInput,
    asset: { ...gpuInput.asset, fingerprint: "0".repeat(64) },
  });
  const folded = foldG3Verdict({
    webgl: stale,
    webgpu: gpuStale,
  });
  assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
  assert.deepEqual(folded.failures, []);
});

test("MUTANT: a one-sided stale ASSET fingerprint is STRUCTURAL, not a parity FAIL", () => {
  for (const forgeRetainedRecomputation of [false, true]) {
    const gl = passingBackend("webgl");
    const gpu = passingBackend("webgpu");
    gpu.assetFingerprint = "b".repeat(64);
    if (forgeRetainedRecomputation) {
      gpu.subLanes.assetSource.measured.recomputedFingerprintSha256 =
        gpu.assetFingerprint;
    }
    const folded = foldG3Verdict({ webgl: gl, webgpu: gpu });
    assert.equal(
      folded.exitCode,
      EXIT_CODE.STRUCTURAL,
      String(forgeRetainedRecomputation),
    );
    assert.deepEqual(folded.failures, []);
    assert.ok(
      folded.structural.some((s) => s.includes("recomputed source proof")),
    );
  }
});

test("MUTANT: missing, null, or malformed source-valid fingerprints are STRUCTURAL", () => {
  for (const value of [undefined, null, "not-a-digest", "A".repeat(64)]) {
    const gl = passingBackend("webgl");
    gl.assetFingerprint = value;
    const folded = foldG3Verdict({
      webgl: gl,
      webgpu: passingBackend("webgpu"),
    });
    assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL, String(value));
    assert.deepEqual(folded.failures, []);
    assert.ok(folded.structural.some((s) => s.includes("fingerprint")));
  }
});

test("MUTANT: every source-valid backend needs the exact trigger-state set", () => {
  const triggerMutants = [
    (backend) => {
      delete backend.triggers[REVERSAL_TRIGGER.SMEARED_MILKY_WAY];
    },
    (backend) => {
      backend.triggers[REVERSAL_TRIGGER.SPRITE_DENSITY] = null;
    },
    (backend) => {
      backend.triggers[REVERSAL_TRIGGER.ALIAS_TWINKLE] = {
        triggered: "true",
      };
    },
    (backend) => {
      backend.triggers.unexpected = { triggered: false };
    },
    (backend) => {
      backend.triggers = null;
    },
  ];
  for (const mutate of triggerMutants) {
    const gl = passingBackend("webgl");
    mutate(gl);
    const folded = foldG3Verdict({
      webgl: gl,
      webgpu: passingBackend("webgpu"),
    });
    assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
    assert.deepEqual(folded.failures, []);
    assert.ok(folded.structural.some((s) => s.includes("trigger")));
  }
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
        .replaceAll(
          '"./owned-resource-transaction.mjs"',
          `"${pathToFileURL(resolve(ROOT, OWNED_RESOURCE_HELPER_REL)).href}"`,
        )
        .replace(
          '"./celestial-metrics.mjs"',
          `"${pathToFileURL(resolve(ROOT, "Tools/visual-regression/lib/celestial-metrics.mjs")).href}"`,
        ),
      "utf8",
    );
    const mutant = await import(pathToFileURL(file).href);
    const gl = passingBackend("webgl");
    const gpu = independentlyValidChangedFingerprintBackend("webgpu");
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

test("the page imports only the browser-safe ownership helper and its graph has no Node built-ins", () => {
  const environment = PROBE.slice(
    PROBE.indexOf("async function g3ReadEnvironment"),
    PROBE.indexOf("async function g3MotionSweep"),
  );
  assert.match(
    environment,
    new RegExp(
      `await\\s+import\\(\\s*["']${OWNED_RESOURCE_HELPER_URL.replaceAll("/", "\\/")}["']\\s*\\)`,
      "u",
    ),
  );
  assert.doesNotMatch(
    environment,
    /import\(\s*["']\/Tools\/visual-regression\/lib\/celestial-g3-gate\.mjs["']\s*\)/u,
  );
  const visited = assertBrowserSafeModuleGraph(OWNED_RESOURCE_HELPER_REL);
  assert.deepEqual([...visited], [resolve(ROOT, OWNED_RESOURCE_HELPER_REL)]);
});

test("MUTANT: the browser import-graph tripwire rejects a transitive Node built-in", () => {
  const entry = resolve(ROOT, OWNED_RESOURCE_HELPER_REL);
  const child = resolve(dirname(entry), "__g3_node_builtin_mutant__.mjs");
  const actual = readFileSync(entry, "utf8");
  assert.throws(
    () =>
      assertBrowserSafeModuleGraph(OWNED_RESOURCE_HELPER_REL, (file) => {
        if (file === entry) {
          return `${actual}\nimport "./__g3_node_builtin_mutant__.mjs";\n`;
        }
        if (file === child) {
          return 'import "node:crypto";\n';
        }
        return readFileSync(file, "utf8");
      }),
    /imports the Node built-in node:crypto/u,
  );
});

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

function assertAppliedBasisWiring(source) {
  const sweep = source.slice(
    source.indexOf("async function g3MotionSweep"),
    source.indexOf("function g3MotionMetrics"),
  );
  assert.match(
    sweep,
    /scene\.camera\.setView\([\s\S]{0,900}scene\.camera\.directionWC[\s\S]{0,300}scene\.camera\.rightWC[\s\S]{0,300}scene\.camera\.upWC/,
  );
  assert.match(
    sweep,
    /projectWith\(\s*brightest\.dir,\s*basis\.applied\.directionWC,\s*basis\.applied\.rightWC,\s*basis\.applied\.upWC/,
  );
  assert.match(
    sweep,
    /projectWith\(\s*faint\.dir,\s*basis\.applied\.directionWC,\s*basis\.applied\.rightWC,\s*basis\.applied\.upWC/,
  );
  assert.match(
    sweep,
    /appliedDirectionWC:\s*packVector\(basis\.applied\.directionWC\)/,
  );
  assert.match(sweep, /brightProjectionBasis:\s*"applied-WC"/);
  assert.match(sweep, /faintProjectionBasis:\s*fp\s*\?\s*"applied-WC"/);
}

test("the G3 motion sweep projects and records the post-setView WC basis", () => {
  assertAppliedBasisWiring(PROBE);
});

test("MUTANT: projecting with the requested direction fails the basis tripwire", () => {
  const mutant = PROBE.replace(
    /basis\.applied\.directionWC,(\s*)basis\.applied\.rightWC,(\s*)basis\.applied\.upWC,/,
    "basis.requested.direction,$1basis.requested.right,$2basis.requested.up,",
  );
  assert.notEqual(mutant, PROBE, "the projection mutation did not apply");
  assert.throws(() => assertAppliedBasisWiring(mutant));
});

test("MUTANT: changing only faint projection to requested basis fails", () => {
  const mutant = PROBE.replace(
    /(faint\.dir,\s*)basis\.applied\.directionWC,(\s*)basis\.applied\.rightWC,(\s*)basis\.applied\.upWC,/,
    "$1basis.requested.direction,$2basis.requested.right,$3basis.requested.up,",
  );
  assert.notEqual(mutant, PROBE, "the faint projection mutation did not apply");
  assert.throws(() => assertAppliedBasisWiring(mutant));
});

function assertActive4096SourceWiring(source) {
  const environment = source.slice(
    source.indexOf("async function g3ReadEnvironment"),
    source.indexOf("async function g3MotionSweep"),
  );
  assert.match(environment, /C\.SkyBox\.Variant\.TYCHO_T5_DIFFUSE/);
  assert.match(environment, /C\.SkyBox\.Resolution\.SIZE_4096/);
  assert.match(
    environment,
    /C\.SkyBox\.createEarthSkyBox\(requestedVariant,\s*\{[\s\S]{0,200}resolution:\s*requestedResolution/,
  );
  assert.doesNotMatch(environment, /SkyBox\.defaultResolution\s*=/);

  const run = source.slice(
    source.indexOf("async function runG3(browser, git)"),
    source.indexOf(
      "// ---------------------------------------------------------------------------\n// GATE G4",
    ),
  );
  assert.match(
    run,
    /const sources = isActiveCandidate\s*\?\s*run\.environment\.activeSources\s*:\s*run\.environment\.variants\[key\]/,
  );
  assert.match(run, /g3BuildActiveSourceProof\(\s*run\.environment,\s*fetched/);
  assert.match(source, /decodedWidth\s*=\s*analyzed\.width/);
  assert.match(source, /decodedHeight\s*=\s*analyzed\.height/);
  const fetcher = source.slice(
    source.indexOf("async function g3FetchVariant"),
    source.indexOf("function g3BuildActiveSourceProof"),
  );
  assert.match(fetcher, /fingerprintRecords\.push\(\{/);
  assert.match(fetcher, /faceKey,[\s\S]{0,180}sourceKey,[\s\S]{0,180}url,/);

  const sourceProof = source.slice(
    source.indexOf("function g3BuildEnvironmentSourceProof"),
    source.indexOf("function g3PreflightEnvironment"),
  );
  for (const field of [
    "defaultResolution",
    "maximumCubeMapSize",
    "requestedResolution",
    "resolvedResolution",
    "resolvedEstimatedVramBytes",
    "currentEstimatedVramBytes",
    "peakEstimatedVramBytes",
  ]) {
    assert.match(sourceProof, new RegExp(`${field}:`));
  }
  const finalProof = source.slice(
    source.indexOf("function g3BuildActiveSourceProof"),
    source.indexOf("function g3BuildEnvironmentSourceProof"),
  );
  assert.match(finalProof, /\.\.\.base/);
  assert.match(
    finalProof,
    /sha256\(\s*canonicalG3ActiveSourceFingerprintPayload\(\{/,
  );
  assert.match(finalProof, /records:\s*fetched\.fingerprintRecords/);
  assert.match(
    run,
    /fingerprints\[renderer\]\s*=\s*activeSourceProofs\[renderer\]\?\.fingerprintSha256\s*\?\?\s*null/,
  );
  assert.doesNotMatch(run, /parts\.join|sourceRole/);
}

test("the probe's G3 asset arm reads and hashes the exact active 4096 request", () => {
  // String surgery on a filename prefix would measure whatever the probe
  // believes ships, not what the engine loads.
  assert.match(PROBE, /const descriptor = C\.SkyBox\.createEarthSkyBox\(v\)/);
  assert.match(PROBE, /variants\[v\] = \{ \.\.\.descriptor\.sources \}/);
  assert.match(PROBE, /descriptor\.destroy\(\)/);
  assert.match(PROBE, /scene\.skyBox\.variant/);
  assertActive4096SourceWiring(PROBE);
});

test("the evaluator independently recomputes the producer's active aggregate", () => {
  const library = readNormalized(LIB_REL);
  const evaluator = library.slice(
    library.indexOf("export function evaluateAssetSourceSubLane"),
    library.indexOf("export function evaluateAssetSubLane"),
  );
  assert.match(
    evaluator,
    /computeG3ActiveSourceFingerprint\(\s*activeSourceFingerprintInputFromProof\(proof\)/,
  );
  assert.match(
    evaluator,
    /proof\.fingerprintSha256\s*!==\s*recomputedFingerprintSha256/,
  );
});

test("a recomputed active face-hash change remains a cross-backend FAIL", () => {
  const gpu = independentlyValidChangedFingerprintBackend("webgpu");
  assert.equal(gpu.subLanes.assetSource.pass, true);
  assert.equal(gpu.structural.length, 0);
  const folded = foldG3Verdict({
    webgl: passingBackend("webgl"),
    webgpu: gpu,
  });
  assert.equal(folded.exitCode, EXIT_CODE.FAIL);
  assert.ok(
    folded.failures.some((failure) =>
      failure.includes("asset_fingerprint_identical"),
    ),
  );
});

test("MUTANT: decoding the default-resolution variant table fails source proof", () => {
  const mutant = PROBE.replace(
    /const sources = isActiveCandidate\s*\?\s*run\.environment\.activeSources\s*:\s*run\.environment\.variants\[key\];/,
    "const sources = run.environment.variants[key];",
  );
  assert.notEqual(mutant, PROBE, "the source-selection mutation did not apply");
  assert.throws(() => assertActive4096SourceWiring(mutant));
});

function assertReplacementLifecycleWiring(source) {
  const environment = source.slice(
    source.indexOf("async function g3ReadEnvironment"),
    source.indexOf("async function g3MotionSweep"),
  );
  assert.match(environment, /const previousSkyBox = scene\.skyBox/);
  assert.match(
    environment,
    /replaceOwnedResourceTransaction\(\{[\s\S]{0,1400}current:\s*previousSkyBox,[\s\S]{0,1400}install:[\s\S]{0,1400}restore:[\s\S]{0,1400}destroy:/,
  );
  assert.match(environment, /previousSkyBox\.isDestroyed\(\)/);
  assert.match(environment, /activeSkyBox\.isDestroyed\(\)/);
  assert.match(environment, /previousResidentEstimatedVramBytes/);
  assert.match(environment, /currentEstimatedVramBytes/);
  assert.match(environment, /peakEstimatedVramBytes/);
  assert.match(environment, /replacementHadRenderOverlap:\s*false/);
}

test("the probe transfers sky-box ownership and reports honest residency", () => {
  assertReplacementLifecycleWiring(PROBE);
});

function assertG3GlobalPreflightBarrier(source) {
  const counters = source.slice(
    source.indexOf("function g3EmptyProductWorkload"),
    source.indexOf("async function runG3BackendPreflight"),
  );
  for (const field of [
    "productPhaseAttempts",
    "setupAttempts",
    "captureAttempts",
    "motionAttempts",
    "fetchAttempts",
    "decodeAttempts",
  ]) {
    assert.match(counters, new RegExp(`${field}:\\s*0`));
  }
  const preflightBackend = source.slice(
    source.indexOf("async function runG3BackendPreflight"),
    source.indexOf("async function runG3BackendProduct"),
  );
  assert.match(preflightBackend, /g3ReadEnvironment\(page\)/);
  assert.match(preflightBackend, /g3PreflightEnvironment\(environment\)/);
  assert.doesNotMatch(
    preflightBackend,
    /setupScene|captureMode|g3MotionSweep|g3FetchVariant|import\("sharp"\)/,
  );
  const productBackend = source.slice(
    source.indexOf("async function runG3BackendProduct"),
    source.indexOf("function g3StructuralResult"),
  );
  for (const field of [
    "productPhaseAttempts",
    "setupAttempts",
    "captureAttempts",
    "motionAttempts",
  ]) {
    assert.match(productBackend, new RegExp(`${field}\\+\\+`));
  }
  const fetcher = source.slice(
    source.indexOf("async function g3FetchVariant"),
    source.indexOf("function g3BuildActiveSourceProof"),
  );
  assert.match(fetcher, /workload\.fetchAttempts\+\+/);
  assert.match(fetcher, /workload\.decodeAttempts\+\+/);
  const run = source.slice(
    source.indexOf("async function runG3(browser, git)"),
    source.indexOf(
      "// ---------------------------------------------------------------------------\n// GATE G4",
    ),
  );
  assert.match(
    run,
    /await Promise\.all\(\[\s*runG3BackendPreflight\(browser, "webgl"\),\s*runG3BackendPreflight\(browser, "webgpu"\),\s*\]\)/,
  );
  const combinedPreflight = run.indexOf(
    "if (!glPreflight.preflight.pass || !gpuPreflight.preflight.pass)",
  );
  const firstProduct = run.indexOf("runG3BackendProduct(browser");
  const analysisImport = run.indexOf('await import("sharp")');
  assert.ok(
    combinedPreflight >= 0 &&
      combinedPreflight < firstProduct &&
      firstProduct < analysisImport,
  );
  assert.match(
    run.slice(combinedPreflight, firstProduct),
    /return g3StructuralResult\([\s\S]*"global-preflight"/,
  );
  const structuralResult = source.slice(
    source.indexOf("function g3StructuralResult"),
    source.indexOf("async function runG3(browser, git)"),
  );
  assert.match(structuralResult, /sharpImportAttempts:\s*0/);
  assert.match(run, /orchestration\.sharpImportAttempts\+\+/);
}

test("both source/device preflights form a barrier before all product work", () => {
  assertG3GlobalPreflightBarrier(PROBE);
});

test("MUTANT: any non-zero mixed-capability product counter fails", () => {
  for (const field of [
    "productPhaseAttempts",
    "setupAttempts",
    "captureAttempts",
    "motionAttempts",
    "fetchAttempts",
    "decodeAttempts",
  ]) {
    const mutant = PROBE.replace(`${field}: 0`, `${field}: 1`);
    assert.notEqual(mutant, PROBE, `${field} mutation did not apply`);
    assert.throws(() => assertG3GlobalPreflightBarrier(mutant));
  }
});

test("MUTANT: deleting any product-work counter increment fails", () => {
  for (const field of [
    "productPhaseAttempts",
    "setupAttempts",
    "captureAttempts",
    "motionAttempts",
    "fetchAttempts",
    "decodeAttempts",
    "sharpImportAttempts",
  ]) {
    const mutant = PROBE.replace(`${field}++`, `${field} += 0`);
    assert.notEqual(mutant, PROBE, `${field} increment mutation did not apply`);
    assert.throws(() => assertG3GlobalPreflightBarrier(mutant));
  }
});

test("MUTANT: starting either product backend inside the preflight barrier fails", () => {
  const mutant = PROBE.replace(
    'runG3BackendPreflight(browser, "webgpu")',
    'runG3BackendProduct(browser, "webgpu")',
  );
  assert.notEqual(mutant, PROBE, "the product-order mutation did not apply");
  assert.throws(() => assertG3GlobalPreflightBarrier(mutant));
});

test("MUTANT: sharp before the all-backend barrier fails", () => {
  const mutant = PROBE.replace(
    "  const [glPreflight, gpuPreflight] = await Promise.all([",
    '  await import("sharp");\n  const [glPreflight, gpuPreflight] = await Promise.all([',
  );
  assert.notEqual(mutant, PROBE, "the early-sharp mutation did not apply");
  assert.throws(() => assertG3GlobalPreflightBarrier(mutant));
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
