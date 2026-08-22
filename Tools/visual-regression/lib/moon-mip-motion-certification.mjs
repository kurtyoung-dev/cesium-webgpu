// @purpose Finalizer for C12-33-SHIMMER-ENVELOPE-CERTIFICATION: paired motion-shimmer separation, seam review, parity, and explicit non-claim of observed mip/LOD selection.
// @status ACTIVE

import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  analyzeRgbaFrame,
  C12_33_DOES_NOT_MEASURE,
  C12_33_FILED_DESIGN_DISCREPANCY,
  C12_33_SHIMMER_ENVELOPE_CERTIFICATION,
  computeMoonMipPreregistrationSha256,
  computeParitySeries,
  computeTemporalSeries,
  evaluateCalibratedQuality,
  evaluatePairedReportSensitivity,
  EXIT_CODES,
  FIXED_TIME_ISO,
  isPortableEvidencePath,
  MOON_MIP_CONTROL_MODES,
  MOON_MIP_MOTION_LANES,
  MOON_MIP_PREREGISTRATION_DESIGN_ID,
  MOON_MIP_PREREGISTRATION_SHA256,
  MOON_MIP_SAMPLE_COUNT,
  PAIRED_SENSITIVITY_REQUIREMENTS,
  summarizeSpatial,
  validateCalibratedThresholds,
  validateStructuralEvidence,
} from "../probe-moon-mip-motion-edge.mjs";
import { sha256 } from "./visual-gate-policy.mjs";

/**
 * Exit codes the NON_CERTIFYING tier has legitimately been recorded under.
 *
 * The tier's MEANING never changed — the lane could not see its subject — but
 * its numeral did. Runs banked before the verdict tiers were named wrote 2, the
 * code the 0/1/2/3 contract reserves for "the harness broke"; the probe now
 * writes 3. Accepting both keeps the banked library readable without widening
 * anything: these are the only two values, both spelled out, and the legacy
 * member is deletable the moment every published run carries the current one.
 *
 * @param {unknown} value Recorded exit code.
 * @returns {boolean} True when the value is a non-certifying exit.
 */
const NON_CERTIFYING_LEGACY_EXIT_CODE = 2;

function isNonCertifyingExitCode(value) {
  return (
    value === EXIT_CODES.STRUCTURAL || value === NON_CERTIFYING_LEGACY_EXIT_CODE
  );
}

// The wire names remain historical aliases so existing publication paths stay
// stable. `certificationClaim` is the controlling human/machine-facing scope.
export const C12_33_CERTIFICATION_SCHEMA =
  "cesium-c12-33-moon-mip-motion-certification/v1";
export const C12_33_REVIEW_SCHEMA = "cesium-c12-33-moon-mip-motion-review/v1";
export const C12_33_CALIBRATION_POLICY =
  "five-pair-observed-normal-envelope/v1";

export const C12_33_COUNTERBALANCED_CONTROL_ORDER = Object.freeze([
  "normal",
  "force-lod0",
  "force-lod0",
  "normal",
  "normal",
  "force-lod0",
  "force-lod0",
  "normal",
  "normal",
  "force-lod0",
]);

export const C12_33_REVIEW_FINDINGS = Object.freeze([
  "seam-centered",
  "seam-at-limb",
  "webgl-webgpu-unresampled-parity",
]);

const VISUAL_EVIDENCE_SCHEMA = "cesium-visual-evidence-publication/v2";
const VISUAL_EVIDENCE_PRODUCER = "c12-33-moon-mip-motion";
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const BACKENDS = Object.freeze(["webgl", "webgpu"]);
const TEMPORAL_MAXIMUM_METRICS = Object.freeze([
  ["maxNormalizedMeanAbsoluteLumaDelta", "normalizedMeanAbsoluteLumaDelta"],
  ["maxNormalizedP95PairLumaDelta", "normalizedP95PairLumaDelta"],
  ["maxNormalizedMeanHighPassDelta", "normalizedMeanHighPassDelta"],
  ["maxNormalizedP95HighPassDelta", "normalizedP95HighPassDelta"],
  [
    "maxSpatialHighFrequencyCoefficientOfVariation",
    "spatialHighFrequencyCoefficientOfVariation",
  ],
]);
const SPATIAL_BANDS = Object.freeze([
  [
    "minNormalizedSpatialHighFrequencyMean",
    "maxNormalizedSpatialHighFrequencyMean",
    "normalizedSpatialHighFrequencyMean",
  ],
  [
    "minNormalizedLaplacianEnergyMean",
    "maxNormalizedLaplacianEnergyMean",
    "normalizedLaplacianEnergyMean",
  ],
]);
const PARITY_BOUNDS = Object.freeze([
  [
    "minMaskIntersectionOverUnionMean",
    "maskIntersectionOverUnionMean",
    "minimum",
  ],
  [
    "maxNormalizedMeanAbsoluteLumaError",
    "normalizedMeanAbsoluteLumaError",
    "maximum",
  ],
  [
    "maxNormalizedP95AbsoluteLumaError",
    "normalizedP95AbsoluteLumaError",
    "maximum",
  ],
  ["maxChangedPixelFractionMean", "changedPixelFractionMean", "maximum"],
]);
const REQUIRED_INTEGRITY_CLAIMS = Object.freeze([
  "sourcePrePostStable",
  "repositoryPrePostStable",
  "activeLockAbsentAtPreflightAndPostflight",
  "runningOrIncompleteMarkerAbsent",
  "contentAddressedObjectsVerified",
  "contentAddressedObjectsAreReadOnly",
  "originalPathViewsAreIndependentCopies",
  "originalPathViewsAreReadOnly",
  "publicationNoClobber",
]);
const MANIFEST_KEYS = Object.freeze([
  "schema",
  "schemaVersion",
  "kind",
  "namespace",
  "producer",
  "runId",
  "publicationPath",
  "publishedAt",
  "result",
  "invocation",
  "legacyImport",
  "upgradedFrom",
  "source",
  "integrity",
  "files",
]);
const FILE_ENTRY_KEYS = Object.freeze([
  "originalPath",
  "role",
  "mediaType",
  "objectPath",
  "viewPath",
  "byteLength",
  "sha256",
  "sourcePre",
  "sourcePost",
]);
const CAPTURE_IDENTITY_KEYS = Object.freeze([
  "byteLength",
  "sha256",
  "modifiedMs",
  "changedMs",
  "device",
  "inode",
]);
const REPOSITORY_PROVENANCE_KEYS = Object.freeze([
  "capturedAt",
  "head",
  "branch",
  "detached",
  "dirty",
  "statusByteLength",
  "statusSha256",
  "statusTokenCount",
]);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_METRIC_BINDING_SCHEMA =
  "cesium-c12-33-moon-mip-png-metric-binding/v1";

// `sha256` is imported from the shared gate policy rather than redefined: this
// module compares its digests with ones other tools in the same pipeline
// produced, so the two must be the same function, not two spellings of it.

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function appendUnique(target, values) {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

export function validateC1233PreregistrationCustody(reports) {
  const failures = [];
  const expectedDesignId = MOON_MIP_PREREGISTRATION_DESIGN_ID;
  const expectedPreregistrationSha256 = computeMoonMipPreregistrationSha256();
  if (!Array.isArray(reports) || reports.length !== 10) {
    return [
      "preregistration custody requires exactly ten raw reports for one certification set",
    ];
  }
  if (new Set(reports.map((report) => report?.designId)).size !== 1) {
    failures.push(
      "ten-run preregistration design drift: every report must carry the same designId",
    );
  }
  if (
    new Set(reports.map((report) => report?.preregistrationSha256)).size !== 1
  ) {
    failures.push(
      "ten-run preregistration hash drift: every report must carry the same preregistrationSha256",
    );
  }
  const first = reports[0];
  for (const report of reports) {
    const runId = report?.runId ?? "unknown";
    if (report?.designId !== expectedDesignId) {
      failures.push(
        `preregistration design drift in raw run ${runId}: committed source expects designId ${expectedDesignId}; report carries ${report?.designId ?? "missing"}`,
      );
    }
    if (report?.preregistrationSha256 !== expectedPreregistrationSha256) {
      failures.push(
        `preregistration hash drift in raw run ${runId}: committed source recomputes ${expectedPreregistrationSha256}; report carries ${report?.preregistrationSha256 ?? "missing"}`,
      );
    }
    if (
      report?.designId !== first?.designId ||
      report?.preregistrationSha256 !== first?.preregistrationSha256
    ) {
      failures.push(
        `ten-run preregistration custody drift: raw run ${runId} carries ${report?.designId ?? "missing"}/${report?.preregistrationSha256 ?? "missing"}, but first run ${first?.runId ?? "unknown"} carries ${first?.designId ?? "missing"}/${first?.preregistrationSha256 ?? "missing"}`,
      );
    }
  }
  return failures;
}

function safePathUnder(root, portablePath) {
  if (
    typeof portablePath !== "string" ||
    portablePath.length === 0 ||
    portablePath.includes("\\") ||
    portablePath.startsWith("/") ||
    /^[A-Za-z]:/u.test(portablePath) ||
    posix.normalize(portablePath) !== portablePath ||
    portablePath
      .split("/")
      .some(
        (component) =>
          component === "." || component === ".." || component === "",
      )
  ) {
    throw new Error(`unsafe publication view path: ${portablePath}`);
  }
  const absolute = resolve(root, ...portablePath.split("/"));
  const child = relative(root, absolute);
  if (
    child === ".." ||
    child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(child)
  ) {
    throw new Error(
      `publication view path escaped its manifest: ${portablePath}`,
    );
  }
  return absolute;
}

function portablePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    posix.normalize(value) !== value ||
    value
      .split("/")
      .some(
        (component) =>
          component === "." || component === ".." || component === "",
      )
  ) {
    throw new Error(`${label} is not a canonical portable path: ${value}`);
  }
  return value;
}

function sameDescriptor(left, right) {
  return (
    left?.size === right?.size &&
    left?.mtimeNs === right?.mtimeNs &&
    left?.ctimeNs === right?.ctimeNs &&
    left?.dev === right?.dev &&
    left?.ino === right?.ino &&
    left?.nlink === right?.nlink &&
    left?.mode === right?.mode
  );
}

function publicDescriptor(value) {
  return {
    size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    nlink: value.nlink.toString(),
    mode: value.mode.toString(),
  };
}

async function assertNoSymbolicComponents(absolutePath) {
  const canonical = resolve(absolutePath);
  const root = parse(canonical).root;
  const components = relative(root, canonical).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    const descriptor = await lstat(current, { bigint: true });
    if (descriptor.isSymbolicLink()) {
      throw new Error(`symbolic path component is forbidden: ${current}`);
    }
  }
}

async function fingerprintRegularFile(
  absolutePath,
  { readOnly = false, singleLink = false } = {},
) {
  const canonical = resolve(absolutePath);
  await assertNoSymbolicComponents(canonical);
  const before = await lstat(canonical, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(
      `immutable input is not a regular non-symlink: ${canonical}`,
    );
  }
  const bytes = await readFile(canonical);
  const after = await lstat(canonical, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameDescriptor(publicDescriptor(before), publicDescriptor(after)) ||
    BigInt(bytes.byteLength) !== after.size
  ) {
    throw new Error(`immutable input changed while read: ${canonical}`);
  }
  if (readOnly && (after.mode & 0o222n) !== 0n) {
    throw new Error(`immutable input is writable: ${canonical}`);
  }
  if (singleLink && after.nlink !== 1n) {
    throw new Error(
      `immutable input has ${after.nlink} hardlinks: ${canonical}`,
    );
  }
  const resolved = await realpath(canonical);
  if (resolve(resolved) !== canonical) {
    throw new Error(`immutable input path is not canonical: ${canonical}`);
  }
  return {
    path: canonical,
    descriptor: publicDescriptor(after),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    bytes,
  };
}

function snapshotFingerprint(fingerprint) {
  return {
    path: fingerprint.path,
    descriptor: { ...fingerprint.descriptor },
    byteLength: fingerprint.byteLength,
    sha256: fingerprint.sha256,
  };
}

export async function revalidateImmutableSnapshots(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error("immutable snapshot set is absent");
  }
  for (const snapshot of snapshots) {
    const current = await fingerprintRegularFile(snapshot.path);
    if (
      !sameDescriptor(current.descriptor, snapshot.descriptor) ||
      current.byteLength !== snapshot.byteLength ||
      current.sha256 !== snapshot.sha256
    ) {
      throw new Error(`immutable input changed before PASS: ${snapshot.path}`);
    }
  }
}

function roundedMetric(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function mean(values) {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const ordered = values.slice().sort((left, right) => left - right);
  return ordered[
    Math.min(
      ordered.length - 1,
      Math.max(0, Math.ceil(fraction * ordered.length) - 1),
    )
  ];
}

function standardDeviation(values, average = mean(values)) {
  if (values.length === 0 || average === null) {
    return null;
  }
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length,
  );
}

function publicDecodedFrame(decoded, pngPath, pngBytes) {
  return {
    pngPath,
    pngSha256: sha256(pngBytes),
    width: decoded.width,
    height: decoded.height,
    coveredPixels: decoded.coveredPixels,
    strayLitPixels: decoded.strayLitPixels,
    principalComponentBounds: decoded.principalComponentBounds,
    coveredFraction: roundedMetric(decoded.coveredFraction),
    coveredMeanLuminance: roundedMetric(decoded.coveredMeanLuminance),
    interiorPixels: decoded.interiorPixels,
    meanInteriorLuminance: roundedMetric(decoded.meanInteriorLuminance),
    gradientEnergy: roundedMetric(decoded.gradientEnergy),
    laplacianEnergy: roundedMetric(decoded.laplacianEnergy),
    normalizedSpatialHighFrequency: roundedMetric(
      decoded.normalizedSpatialHighFrequency,
    ),
    normalizedLaplacianEnergy: roundedMetric(decoded.normalizedLaplacianEnergy),
    illuminatedBounds: decoded.illuminatedBounds,
    discDiameterPx: decoded.discDiameterPx,
  };
}

function recomputeTemporalSummary(frames, pairs) {
  const meanDeltas = pairs.map((pair) => pair.meanAbsoluteLumaDelta);
  const normalizedDeltas = pairs.map(
    (pair) => pair.normalizedMeanAbsoluteLumaDelta,
  );
  const normalizedHighPass = pairs.map(
    (pair) => pair.normalizedMeanHighPassDelta,
  );
  const spatialValues = frames.map(
    (frame) => frame.normalizedSpatialHighFrequency,
  );
  const spatialMean = mean(spatialValues) ?? 0;
  return {
    pairCount: pairs.length,
    comparedPixelsMin:
      pairs.length > 0
        ? Math.min(...pairs.map((pair) => pair.comparedPixels))
        : 0,
    meanAbsoluteLumaDelta: mean(meanDeltas) ?? 0,
    p95PairMeanAbsoluteLumaDelta: percentile(meanDeltas, 0.95) ?? 0,
    normalizedMeanAbsoluteLumaDelta: mean(normalizedDeltas) ?? 0,
    normalizedP95PairLumaDelta: percentile(normalizedDeltas, 0.95) ?? 0,
    normalizedMeanHighPassDelta: mean(normalizedHighPass) ?? 0,
    normalizedP95HighPassDelta: percentile(normalizedHighPass, 0.95) ?? 0,
    spatialHighFrequencyMean: spatialMean,
    spatialHighFrequencyP95: percentile(spatialValues, 0.95) ?? 0,
    spatialHighFrequencyCoefficientOfVariation:
      (standardDeviation(spatialValues, spatialMean) ?? 0) /
      Math.max(1e-9, spatialMean),
  };
}

function recomputeParitySummary(samples) {
  const keyMean = (key) => mean(samples.map((sample) => sample[key])) ?? 0;
  return {
    sampleCount: samples.length,
    comparedPixelsMin:
      samples.length > 0
        ? Math.min(...samples.map((sample) => sample.comparedPixels))
        : 0,
    maskIntersectionOverUnionMean: keyMean("maskIntersectionOverUnion"),
    meanAbsoluteRgbError: keyMean("meanAbsoluteRgbError"),
    meanAbsoluteLumaError: keyMean("meanAbsoluteLumaError"),
    normalizedMeanAbsoluteLumaError: keyMean("normalizedMeanAbsoluteLumaError"),
    normalizedP95AbsoluteLumaError:
      percentile(
        samples.map((sample) => sample.normalizedMeanAbsoluteLumaError),
        0.95,
      ) ?? 0,
    changedPixelFractionMean: keyMean("changedPixelFraction"),
    spatialHighFrequencyRatioMean: keyMean("spatialHighFrequencyRatio"),
  };
}

async function decodeImmutablePng(bytes, originalPath) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.byteLength < PNG_SIGNATURE.byteLength ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    throw new Error(`published PNG has a non-PNG signature: ${originalPath}`);
  }
  let image;
  let metadata;
  try {
    image = sharp(bytes, {
      failOn: "error",
      limitInputPixels: 16_000_000,
      sequentialRead: true,
    });
    metadata = await image.metadata();
  } catch (error) {
    throw new Error(
      `published PNG could not be decoded: ${originalPath}: ${String(error?.message ?? error)}`,
      { cause: error },
    );
  }
  if (
    metadata.format !== "png" ||
    (metadata.pages ?? 1) !== 1 ||
    !Number.isInteger(metadata.width) ||
    !Number.isInteger(metadata.height) ||
    metadata.width <= 0 ||
    metadata.height <= 0
  ) {
    throw new Error(
      `published PNG format is not a single PNG: ${originalPath}`,
    );
  }
  try {
    const { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) {
      throw new Error(`decoded channel count was ${info.channels}`);
    }
    return analyzeRgbaFrame({ data, width: info.width, height: info.height });
  } catch (error) {
    throw new Error(
      `published PNG pixel decode failed: ${originalPath}: ${String(error?.message ?? error)}`,
      { cause: error },
    );
  }
}

function metricBindingDocument(report) {
  return {
    schema: PNG_METRIC_BINDING_SCHEMA,
    runId: report?.runId ?? null,
    lanes: (report?.lanes ?? []).map((lane) => ({
      id: lane?.id ?? null,
      backends: Object.fromEntries(
        BACKENDS.map((backend) => [
          backend,
          {
            frames: lane?.backends?.[backend]?.frames ?? null,
            spatial: lane?.backends?.[backend]?.spatial ?? null,
            temporal: lane?.backends?.[backend]?.temporal ?? null,
          },
        ]),
      ),
      parity: lane?.parity ?? null,
    })),
  };
}

export function moonMipMetricBindingSha256(report) {
  return sha256(canonicalJson(metricBindingDocument(report)));
}

async function verifyPublishedPngMetrics(
  report,
  reportOriginalPath,
  verifiedEntries,
) {
  const verifiedByOriginalPath = new Map(
    verifiedEntries.map((verified) => [verified.entry.originalPath, verified]),
  );
  const reportDirectory = posix.dirname(reportOriginalPath);
  for (const lane of report.lanes) {
    const rawFrames = {};
    const publicFrames = {};
    for (const backend of BACKENDS) {
      rawFrames[backend] = [];
      publicFrames[backend] = [];
      for (const frame of lane.backends[backend].frames) {
        const originalPath = posix.normalize(
          posix.join(reportDirectory, frame.pngPath),
        );
        const verified = verifiedByOriginalPath.get(originalPath);
        if (
          verified?.entry?.role !== "file" ||
          verified.entry.mediaType !== "image/png"
        ) {
          throw new Error(
            `raw frame does not resolve to an immutable published PNG: ${originalPath}`,
          );
        }
        const decoded = await decodeImmutablePng(verified.bytes, originalPath);
        const publicFrame = publicDecodedFrame(
          decoded,
          frame.pngPath,
          verified.bytes,
        );
        if (!sameJson(frame, publicFrame)) {
          throw new Error(
            `published PNG metric primitives disagree with decoded pixels: ${originalPath}`,
          );
        }
        rawFrames[backend].push(decoded);
        publicFrames[backend].push(publicFrame);
      }
      const temporal = computeTemporalSeries(rawFrames[backend]);
      Object.assign(
        temporal,
        recomputeTemporalSummary(publicFrames[backend], temporal.pairs),
      );
      if (
        !sameJson(
          lane.backends[backend].spatial,
          summarizeSpatial(publicFrames[backend]),
        ) ||
        !sameJson(lane.backends[backend].temporal, temporal)
      ) {
        throw new Error(
          `published PNG temporal/spatial summaries disagree with decoded pixels: ${lane.id}/${backend}`,
        );
      }
    }
    const parity = computeParitySeries(rawFrames.webgl, rawFrames.webgpu);
    parity.samples.forEach((sample, sampleIndex) => {
      sample.spatialHighFrequencyRatio =
        publicFrames.webgpu[sampleIndex].normalizedSpatialHighFrequency /
        Math.max(
          1e-9,
          publicFrames.webgl[sampleIndex].normalizedSpatialHighFrequency,
        );
    });
    Object.assign(parity, recomputeParitySummary(parity.samples));
    if (!sameJson(lane.parity, parity)) {
      throw new Error(
        `published PNG parity primitives/summaries disagree with decoded pixels: ${lane.id}`,
      );
    }
  }
  return {
    schema: PNG_METRIC_BINDING_SCHEMA,
    sha256: moonMipMetricBindingSha256(report),
  };
}

function expectedMediaType(originalPath) {
  if (originalPath.endsWith(".json")) {
    return "application/json";
  }
  if (originalPath.endsWith(".png")) {
    return "image/png";
  }
  return null;
}

function validCaptureIdentity(value, shaValue, byteLength) {
  return (
    exactKeys(value, CAPTURE_IDENTITY_KEYS) &&
    value.sha256 === shaValue &&
    value.byteLength === byteLength &&
    Number.isInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    Number.isFinite(value.modifiedMs) &&
    value.modifiedMs >= 0 &&
    Number.isFinite(value.changedMs) &&
    value.changedMs >= 0 &&
    Number.isInteger(value.device) &&
    value.device >= 0 &&
    Number.isInteger(value.inode) &&
    value.inode >= 0
  );
}

function sameCaptureIdentity(left, right) {
  return CAPTURE_IDENTITY_KEYS.every((key) => left?.[key] === right?.[key]);
}

function reportPngFrames(report) {
  const frames = [];
  for (const lane of report?.lanes ?? []) {
    for (const backend of BACKENDS) {
      for (const frame of lane?.backends?.[backend]?.frames ?? []) {
        frames.push({ laneId: lane.id, backend, ...frame });
      }
    }
  }
  return frames;
}

function repositorySnapshotIdentity(snapshot) {
  return {
    head: snapshot?.head ?? null,
    branch: snapshot?.branch ?? null,
    detached: snapshot?.detached ?? null,
    dirty: snapshot?.dirty ?? null,
    statusByteLength: snapshot?.statusByteLength ?? null,
    statusSha256: snapshot?.statusSha256 ?? null,
    statusTokenCount: snapshot?.statusTokenCount ?? null,
  };
}

export function validateRawMoonMipReport(report) {
  const failures = [];
  if (report?.schemaVersion !== 1) {
    failures.push("raw report schemaVersion must equal 1");
  }
  if (
    report?.campaign !== "C12-33" ||
    report?.probe !== "probe-moon-mip-motion-edge"
  ) {
    failures.push("raw report campaign/probe identity is invalid");
  }
  if (
    report?.certificationClaim !== C12_33_SHIMMER_ENVELOPE_CERTIFICATION ||
    !sameJson(report?.doesNotMeasure, C12_33_DOES_NOT_MEASURE)
  ) {
    failures.push(
      "raw report does not carry the exact shimmer-envelope claim and mip/LOD non-claim",
    );
  }
  if (
    typeof report?.designId !== "string" ||
    report.designId.length === 0 ||
    !HASH_PATTERN.test(report?.preregistrationSha256 ?? "")
  ) {
    failures.push("raw report preregistration custody fields are malformed");
  }
  if (report?.filedDiscrepancy !== C12_33_FILED_DESIGN_DISCREPANCY) {
    failures.push(
      "raw report filed R-24 design discrepancy is missing or changed",
    );
  }
  if (!TOKEN_PATTERN.test(report?.runId ?? "")) {
    failures.push("raw report runId is invalid");
  }
  if (!canonicalTimestamp(report?.capturedAt)) {
    failures.push("raw report capturedAt is not canonical ISO-8601");
  }
  if (!MOON_MIP_CONTROL_MODES.includes(report?.controlMode)) {
    failures.push("raw report control mode is invalid");
  }
  if (report?.browser?.channel !== "msedge") {
    failures.push("raw report browser channel must be msedge");
  }
  if (
    report?.control?.requestedMode !== report?.controlMode ||
    report?.control?.appliedMode !== report?.controlMode
  ) {
    failures.push("raw report requested/applied control labels are invalid");
  }
  const expectedBaseLevelOnly = report?.controlMode === "force-lod0";
  if (
    report?.control?.webgl?.baseLevelOnly !== expectedBaseLevelOnly ||
    report?.control?.webgpu?.baseLevelOnly !== expectedBaseLevelOnly
  ) {
    failures.push(
      `raw report ${report?.controlMode ?? "unknown"} baseLevelOnly state is invalid`,
    );
  }
  if (
    report?.controlMode === "normal" &&
    report?.control?.webgpu?.bindGroupRebuilt !== false
  ) {
    failures.push(
      "raw normal report unexpectedly rebuilt the WebGPU bind group",
    );
  }
  if (
    report?.controlMode === "force-lod0" &&
    report?.control?.webgpu?.bindGroupRebuilt !== true
  ) {
    failures.push(
      "raw force-lod0 report did not rebuild the WebGPU bind group",
    );
  }
  if (report?.fixedTimeIso !== FIXED_TIME_ISO) {
    failures.push("raw report fixed clock differs from the fixture instant");
  }
  if (report?.sampleCount !== MOON_MIP_SAMPLE_COUNT) {
    failures.push(`raw report sampleCount must equal ${MOON_MIP_SAMPLE_COUNT}`);
  }
  if (
    report?.status !== "NON_CERTIFYING" ||
    !isNonCertifyingExitCode(report?.exitCode) ||
    report?.certificationEligible !== false
  ) {
    failures.push(
      "raw structurally-green report must be NON_CERTIFYING with a structural exit",
    );
  }
  if (
    report?.measurementStatus !== "CALIBRATION_PENDING" ||
    report?.calibratedThresholds !== null ||
    report?.result?.verdict !== "INCONCLUSIVE" ||
    !isNonCertifyingExitCode(report?.result?.exitCode)
  ) {
    failures.push("raw report attempted to bypass offline calibration");
  }
  if (
    !Array.isArray(report?.result?.hardFailures) ||
    report.result.hardFailures.length !== 0 ||
    !Array.isArray(report?.result?.qualityFailures) ||
    report.result.qualityFailures.length !== 0 ||
    !Array.isArray(report?.result?.failures) ||
    report.result.failures.length !== 0 ||
    !Array.isArray(report?.result?.inconclusive) ||
    report.result.inconclusive.length === 0
  ) {
    failures.push(
      "raw report result classification is contradictory or incomplete",
    );
  }
  if (
    report?.manualInspection?.status !== "PENDING" ||
    !Array.isArray(report?.manualInspection?.evidence) ||
    report.manualInspection.evidence.length !== 0
  ) {
    failures.push("raw report attempted to embed its own reviewer attestation");
  }
  const recomputedStructural = validateStructuralEvidence(report);
  appendUnique(
    failures,
    recomputedStructural.map(
      (failure) => `recomputed raw structural failure: ${failure}`,
    ),
  );
  const laneIds = Array.isArray(report?.lanes)
    ? report.lanes.map((lane) => lane?.id)
    : [];
  const expectedLaneIds = MOON_MIP_MOTION_LANES.map((lane) => lane.id);
  if (!sameJson(laneIds, expectedLaneIds)) {
    failures.push("raw report lane order is not the fixed four-lane order");
  }
  const frames = reportPngFrames(report);
  if (frames.length !== 104) {
    failures.push(
      `raw report contains ${frames.length} PNG frames instead of 104`,
    );
  }
  const paths = new Set();
  for (const frame of frames) {
    if (!isPortableEvidencePath(frame.pngPath)) {
      failures.push(
        `raw report contains non-portable PNG path ${frame.pngPath}`,
      );
    }
    if (paths.has(frame.pngPath)) {
      failures.push(`raw report repeats PNG path ${frame.pngPath}`);
    }
    paths.add(frame.pngPath);
    if (!HASH_PATTERN.test(frame.pngSha256 ?? "")) {
      failures.push(`raw report PNG hash is invalid for ${frame.pngPath}`);
    }
  }
  for (const lane of report?.lanes ?? []) {
    for (const backend of BACKENDS) {
      const capture = lane?.backends?.[backend];
      const expectedSelector =
        backend === "webgl" ? "#leftViewer canvas" : "#rightViewer canvas";
      if (
        capture?.captureKind !== "playwright-canvas-element-png" ||
        capture?.canvasSelector !== expectedSelector
      ) {
        failures.push(
          `raw report capture identity is invalid: ${lane?.id}/${backend}`,
        );
      }
      const temporal = lane?.backends?.[backend]?.temporal;
      const spatial = lane?.backends?.[backend]?.spatial;
      for (const [path, value] of [
        [
          "normalizedMeanAbsoluteLumaDelta",
          temporal?.normalizedMeanAbsoluteLumaDelta,
        ],
        ["normalizedP95PairLumaDelta", temporal?.normalizedP95PairLumaDelta],
        ["normalizedMeanHighPassDelta", temporal?.normalizedMeanHighPassDelta],
        ["normalizedP95HighPassDelta", temporal?.normalizedP95HighPassDelta],
        [
          "spatialHighFrequencyCoefficientOfVariation",
          temporal?.spatialHighFrequencyCoefficientOfVariation,
        ],
        [
          "normalizedSpatialHighFrequencyMean",
          spatial?.normalizedSpatialHighFrequencyMean,
        ],
        [
          "normalizedLaplacianEnergyMean",
          spatial?.normalizedLaplacianEnergyMean,
        ],
        ["discDiameterPxMedian", spatial?.discDiameterPxMedian],
      ]) {
        if (!Number.isFinite(value) || value < 0) {
          failures.push(
            `raw report metric is not finite/non-negative: ${lane?.id}/${backend}/${path}`,
          );
        }
      }
    }
    for (const [path, value, maximum] of [
      [
        "maskIntersectionOverUnionMean",
        lane?.parity?.maskIntersectionOverUnionMean,
        1,
      ],
      [
        "normalizedMeanAbsoluteLumaError",
        lane?.parity?.normalizedMeanAbsoluteLumaError,
        Infinity,
      ],
      [
        "normalizedP95AbsoluteLumaError",
        lane?.parity?.normalizedP95AbsoluteLumaError,
        Infinity,
      ],
      ["changedPixelFractionMean", lane?.parity?.changedPixelFractionMean, 1],
    ]) {
      if (!Number.isFinite(value) || value < 0 || value > maximum) {
        failures.push(
          `raw report parity metric is outside its finite domain: ${lane?.id}/${path}`,
        );
      }
    }
  }
  return failures;
}

function validateManifestShape(manifest) {
  const failures = [];
  if (
    !exactKeys(manifest, MANIFEST_KEYS) ||
    manifest?.schema !== VISUAL_EVIDENCE_SCHEMA ||
    manifest?.schemaVersion !== 2 ||
    manifest?.kind !== "run" ||
    manifest?.namespace !== null ||
    manifest?.producer !== VISUAL_EVIDENCE_PRODUCER ||
    manifest?.legacyImport !== null ||
    manifest?.upgradedFrom !== null ||
    !TOKEN_PATTERN.test(manifest?.runId ?? "") ||
    manifest?.publicationPath !==
      `runs/${VISUAL_EVIDENCE_PRODUCER}/${manifest?.runId ?? ""}` ||
    !canonicalTimestamp(manifest?.publishedAt)
  ) {
    failures.push("source publication is not the exact fixed v2 run manifest");
  }
  if (
    !exactKeys(manifest?.result, [
      "status",
      "exitCode",
      "certificationEligible",
    ]) ||
    manifest?.result?.status !== "NON_CERTIFYING" ||
    !isNonCertifyingExitCode(manifest?.result?.exitCode) ||
    manifest?.result?.certificationEligible !== false
  ) {
    failures.push(
      "source publication result is not NON_CERTIFYING with a structural exit",
    );
  }
  const command = manifest?.invocation?.command;
  if (
    !exactKeys(manifest?.invocation, ["command"]) ||
    (command !== null &&
      (!exactKeys(command, ["commandSha256", "commandByteLength"]) ||
        !HASH_PATTERN.test(command?.commandSha256 ?? "") ||
        !Number.isInteger(command?.commandByteLength) ||
        command.commandByteLength < 0))
  ) {
    failures.push("source publication invocation identity is malformed");
  }
  const repository = manifest?.source?.repository;
  if (
    !exactKeys(manifest?.source, [
      "worktreeLabel",
      "guardPath",
      "repository",
    ]) ||
    !TOKEN_PATTERN.test(manifest?.source?.worktreeLabel ?? "") ||
    (manifest?.source?.guardPath !== "." &&
      (() => {
        try {
          portablePath(manifest?.source?.guardPath, "source.guardPath");
          return false;
        } catch (_error) {
          return true;
        }
      })()) ||
    !exactKeys(repository, ["pre", "post", "stable"]) ||
    !exactKeys(repository?.pre, REPOSITORY_PROVENANCE_KEYS) ||
    !exactKeys(repository?.post, REPOSITORY_PROVENANCE_KEYS) ||
    repository?.stable !== true ||
    !canonicalTimestamp(repository?.pre?.capturedAt) ||
    !canonicalTimestamp(repository?.post?.capturedAt) ||
    repository.pre.capturedAt > repository.post.capturedAt ||
    !/^[0-9a-f]{40}$/u.test(repository?.pre?.head ?? "") ||
    !HASH_PATTERN.test(repository?.pre?.statusSha256 ?? "") ||
    typeof repository?.pre?.detached !== "boolean" ||
    typeof repository?.pre?.dirty !== "boolean" ||
    !Number.isInteger(repository?.pre?.statusByteLength) ||
    repository.pre.statusByteLength < 0 ||
    !Number.isInteger(repository?.pre?.statusTokenCount) ||
    repository.pre.statusTokenCount < 0 ||
    !sameJson(
      repositorySnapshotIdentity(repository?.pre),
      repositorySnapshotIdentity(repository?.post),
    )
  ) {
    failures.push("source publication repository identity was not stable");
  }
  if (
    !exactKeys(manifest?.integrity, REQUIRED_INTEGRITY_CLAIMS) ||
    REQUIRED_INTEGRITY_CLAIMS.some(
      (claim) => manifest?.integrity?.[claim] !== true,
    )
  ) {
    failures.push("source publication integrity claim schema is incomplete");
  }
  if (!Array.isArray(manifest?.files) || manifest.files.length !== 105) {
    failures.push("source publication must contain one report and 104 PNGs");
  }
  return failures;
}

async function publicationTreeFiles(
  directory,
  root = directory,
  directories = [],
) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const descriptor = await lstat(absolute, { bigint: true });
    if (descriptor.isSymbolicLink()) {
      throw new Error(`publication tree contains a symlink: ${absolute}`);
    }
    if (descriptor.isDirectory()) {
      directories.push(relative(root, absolute).split(sep).join("/"));
      files.push(...(await publicationTreeFiles(absolute, root, directories)));
    } else if (descriptor.isFile()) {
      files.push(relative(root, absolute).split(sep).join("/"));
    } else {
      throw new Error(
        `publication tree contains a non-file entry: ${absolute}`,
      );
    }
  }
  return files;
}

async function fingerprintDirectory(absolutePath) {
  const canonical = resolve(absolutePath);
  await assertNoSymbolicComponents(canonical);
  const before = await lstat(canonical, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`immutable topology path is not a directory: ${canonical}`);
  }
  const resolved = await realpath(canonical);
  const after = await lstat(canonical, { bigint: true });
  if (
    resolve(resolved) !== canonical ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !sameDescriptor(publicDescriptor(before), publicDescriptor(after))
  ) {
    throw new Error(`immutable directory topology changed: ${canonical}`);
  }
  return { path: canonical, descriptor: publicDescriptor(after) };
}

async function snapshotEvidenceDirectories(
  libraryRoot,
  publicationDirectory,
  verifiedEntries,
) {
  const root = resolve(libraryRoot);
  const paths = new Set([
    root,
    resolve(root, "runs"),
    resolve(root, "objects"),
    resolve(publicationDirectory),
  ]);
  for (const verified of verifiedEntries) {
    for (const filePath of [
      verified.viewAbsolutePath,
      verified.objectAbsolutePath,
    ]) {
      let current = dirname(resolve(filePath));
      while (true) {
        const child = relative(root, current);
        if (
          child === ".." ||
          child.startsWith(`..${sep}`) ||
          isAbsolute(child)
        ) {
          throw new Error(
            `immutable evidence directory escaped its library root: ${current}`,
          );
        }
        paths.add(current);
        if (current === root) {
          break;
        }
        current = dirname(current);
      }
    }
  }
  const snapshots = [];
  for (const path of [...paths].sort()) {
    snapshots.push(await fingerprintDirectory(path));
  }
  return snapshots;
}

async function revalidateImmutableDirectorySnapshots(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error("immutable directory snapshot set is absent");
  }
  for (const snapshot of snapshots) {
    const current = await fingerprintDirectory(snapshot.path);
    if (!sameDescriptor(current.descriptor, snapshot.descriptor)) {
      throw new Error(
        `immutable directory topology changed before PASS: ${snapshot.path}`,
      );
    }
  }
}

function fullEntryBinding(entry) {
  return {
    originalPath: entry.originalPath,
    role: entry.role,
    mediaType: entry.mediaType,
    objectPath: entry.objectPath,
    viewPath: entry.viewPath,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
  };
}

export async function loadPublishedMoonMipRun(manifestPath) {
  const absoluteManifestPath = resolve(manifestPath);
  const manifestDirectory = dirname(absoluteManifestPath);
  const manifestFingerprint = await fingerprintRegularFile(
    absoluteManifestPath,
    { readOnly: true, singleLink: true },
  );
  const manifestSha256 = manifestFingerprint.sha256;
  const manifestBytes = manifestFingerprint.bytes;
  const sidecarPath = resolve(manifestDirectory, "manifest.sha256");
  const sidecarFingerprint = await fingerprintRegularFile(sidecarPath, {
    readOnly: true,
    singleLink: true,
  });
  if (sidecarFingerprint.bytes.toString("utf8") !== `${manifestSha256}\n`) {
    throw new Error(
      "source publication manifest.sha256 disagrees with manifest bytes",
    );
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const manifestFailures = validateManifestShape(manifest);
  if (manifestFailures.length > 0) {
    throw new Error(manifestFailures.join("; "));
  }
  portablePath(manifest.publicationPath, "manifest.publicationPath");
  const publicationComponents = manifest.publicationPath.split("/");
  const libraryRoot = resolve(
    manifestDirectory,
    ...publicationComponents.map(() => ".."),
  );
  const expectedPublicationDirectory = safePathUnder(
    libraryRoot,
    manifest.publicationPath,
  );
  if (
    expectedPublicationDirectory !== manifestDirectory ||
    absoluteManifestPath !== resolve(manifestDirectory, "manifest.json")
  ) {
    throw new Error(
      "source publication path does not canonically match manifest.publicationPath",
    );
  }
  await assertNoSymbolicComponents(libraryRoot);
  await assertNoSymbolicComponents(manifestDirectory);
  if (
    resolve(await realpath(libraryRoot)) !== libraryRoot ||
    resolve(await realpath(manifestDirectory)) !== manifestDirectory
  ) {
    throw new Error("source publication directory topology is not canonical");
  }
  const originalPaths = new Set();
  const viewPaths = new Set();
  const viewFileIdentities = new Set();
  const snapshots = [
    snapshotFingerprint(manifestFingerprint),
    snapshotFingerprint(sidecarFingerprint),
  ];
  const snapshotPaths = new Set(snapshots.map((snapshot) => snapshot.path));
  const verifiedEntries = [];
  for (const entry of manifest.files) {
    if (
      !exactKeys(entry, FILE_ENTRY_KEYS) ||
      !HASH_PATTERN.test(entry?.sha256 ?? "") ||
      !Number.isInteger(entry?.byteLength) ||
      entry.byteLength < 0
    ) {
      throw new Error("publication file identity/schema is malformed");
    }
    portablePath(entry.originalPath, "manifest file originalPath");
    const foldedOriginalPath = entry.originalPath.toLocaleLowerCase("en-US");
    if (originalPaths.has(foldedOriginalPath)) {
      throw new Error(
        `duplicate publication originalPath: ${entry.originalPath}`,
      );
    }
    originalPaths.add(foldedOriginalPath);
    const expectedViewPath = posix.join("files", entry.originalPath);
    const expectedObjectPath = posix.join(
      "objects",
      "sha256",
      entry.sha256.slice(0, 2),
      entry.sha256,
    );
    if (
      entry.viewPath !== expectedViewPath ||
      entry.objectPath !== expectedObjectPath ||
      entry.mediaType !== expectedMediaType(entry.originalPath) ||
      !validCaptureIdentity(entry.sourcePre, entry.sha256, entry.byteLength) ||
      !validCaptureIdentity(entry.sourcePost, entry.sha256, entry.byteLength) ||
      !sameCaptureIdentity(entry.sourcePre, entry.sourcePost)
    ) {
      throw new Error(
        `publication entry path/media/source identity is invalid: ${entry.originalPath}`,
      );
    }
    if (viewPaths.has(entry.viewPath)) {
      throw new Error(`duplicate publication viewPath: ${entry.viewPath}`);
    }
    viewPaths.add(entry.viewPath);
    const viewAbsolutePath = safePathUnder(manifestDirectory, entry.viewPath);
    const objectAbsolutePath = safePathUnder(libraryRoot, entry.objectPath);
    const [viewFingerprint, objectFingerprint] = await Promise.all([
      fingerprintRegularFile(viewAbsolutePath, {
        readOnly: true,
        singleLink: true,
      }),
      fingerprintRegularFile(objectAbsolutePath, {
        readOnly: true,
        singleLink: true,
      }),
    ]);
    for (const fingerprint of [viewFingerprint, objectFingerprint]) {
      if (
        fingerprint.byteLength !== entry.byteLength ||
        fingerprint.sha256 !== entry.sha256
      ) {
        throw new Error(
          `publication file bytes disagree with manifest: ${entry.viewPath}`,
        );
      }
      if (!snapshotPaths.has(fingerprint.path)) {
        snapshots.push(snapshotFingerprint(fingerprint));
        snapshotPaths.add(fingerprint.path);
      }
    }
    const viewIdentity = `${viewFingerprint.descriptor.dev}:${viewFingerprint.descriptor.ino}`;
    const objectIdentity = `${objectFingerprint.descriptor.dev}:${objectFingerprint.descriptor.ino}`;
    if (viewIdentity === objectIdentity) {
      throw new Error(
        `publication view is not independent from its object: ${entry.viewPath}`,
      );
    }
    if (viewFileIdentities.has(viewIdentity)) {
      throw new Error(
        `publication views alias one file identity: ${entry.viewPath}`,
      );
    }
    viewFileIdentities.add(viewIdentity);
    verifiedEntries.push({
      entry,
      bytes: viewFingerprint.bytes,
      viewAbsolutePath,
      objectAbsolutePath,
    });
  }
  const jsonEntries = manifest.files.filter(
    (entry) =>
      entry?.role === "artifact" &&
      entry?.mediaType === "application/json" &&
      typeof entry?.originalPath === "string" &&
      entry.originalPath.endsWith(".json"),
  );
  const pngEntries = manifest.files.filter(
    (entry) => entry?.role === "file" && entry?.mediaType === "image/png",
  );
  if (jsonEntries.length !== 1 || pngEntries.length !== 104) {
    throw new Error(
      "source publication does not contain exactly one JSON report and 104 PNGs",
    );
  }
  if (
    manifest.files.some(
      (entry) => entry !== jsonEntries[0] && !pngEntries.includes(entry),
    )
  ) {
    throw new Error("source publication contains an invalid role/media entry");
  }
  const expectedTreeFiles = new Set([
    "manifest.json",
    "manifest.sha256",
    ...manifest.files.map((entry) => entry.viewPath),
  ]);
  const expectedTreeDirectories = new Set(["files"]);
  for (const entry of manifest.files) {
    let directory = posix.dirname(entry.viewPath);
    while (directory !== ".") {
      expectedTreeDirectories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  const treeDirectories = [];
  const actualTreeFiles = new Set(
    await publicationTreeFiles(
      manifestDirectory,
      manifestDirectory,
      treeDirectories,
    ),
  );
  const actualTreeDirectories = new Set(treeDirectories);
  if (
    actualTreeFiles.size !== expectedTreeFiles.size ||
    [...actualTreeFiles].some((path) => !expectedTreeFiles.has(path)) ||
    actualTreeDirectories.size !== expectedTreeDirectories.size ||
    [...actualTreeDirectories].some(
      (path) => !expectedTreeDirectories.has(path),
    )
  ) {
    throw new Error(
      "source publication tree contains missing/unmanifested files",
    );
  }
  const verifiedReport = verifiedEntries.find(
    ({ entry }) => entry === jsonEntries[0],
  );
  const report = JSON.parse(verifiedReport.bytes.toString("utf8"));
  const rawFailures = validateRawMoonMipReport(report);
  if (rawFailures.length > 0) {
    throw new Error(rawFailures.join("; "));
  }
  if (
    manifest.runId !== report.runId ||
    manifest.result.status !== report.status ||
    manifest.result.exitCode !== report.exitCode ||
    manifest.result.certificationEligible !== report.certificationEligible
  ) {
    throw new Error(
      "source publication identity disagrees with its raw report",
    );
  }
  const expectedPngs = new Map();
  const reportDirectory = posix.dirname(jsonEntries[0].originalPath);
  for (const frame of reportPngFrames(report)) {
    const originalPath = posix.normalize(
      posix.join(reportDirectory, frame.pngPath),
    );
    if (expectedPngs.has(originalPath)) {
      throw new Error(`raw report repeats published PNG ${originalPath}`);
    }
    expectedPngs.set(originalPath, frame.pngSha256);
  }
  const pngs = [];
  for (const entry of pngEntries) {
    const expectedHash = expectedPngs.get(entry.originalPath);
    if (expectedHash === undefined || expectedHash !== entry.sha256) {
      throw new Error(
        `source publication PNG is absent from or disagrees with the raw report: ${entry.originalPath}`,
      );
    }
    pngs.push(fullEntryBinding(entry));
  }
  pngs.sort((left, right) =>
    left.originalPath.localeCompare(right.originalPath),
  );
  const metricBinding = await verifyPublishedPngMetrics(
    report,
    jsonEntries[0].originalPath,
    verifiedEntries,
  );
  const immutableDirectorySnapshots = await snapshotEvidenceDirectories(
    libraryRoot,
    manifestDirectory,
    verifiedEntries,
  );
  return {
    manifestPath: absoluteManifestPath,
    publicationDirectory: manifestDirectory,
    libraryRoot,
    manifest,
    manifestByteLength: manifestBytes.byteLength,
    manifestSha256,
    manifestCanonicalSha256: sha256(canonicalJson(manifest)),
    report,
    reportOriginalPath: jsonEntries[0].originalPath,
    reportRole: jsonEntries[0].role,
    reportMediaType: jsonEntries[0].mediaType,
    reportObjectPath: jsonEntries[0].objectPath,
    reportViewPath: jsonEntries[0].viewPath,
    reportByteLength: verifiedReport.bytes.byteLength,
    reportSha256: sha256(verifiedReport.bytes),
    reportCanonicalSha256: sha256(canonicalJson(report)),
    pngs,
    metricBinding,
    immutableSnapshots: snapshots,
    immutableDirectorySnapshots,
    publicationVerified: true,
  };
}

function sourceRepositoryIdentity(source) {
  return repositorySnapshotIdentity(source.manifest?.source?.repository?.pre);
}

export function reviewerSourceBindings(sources) {
  return sources.map((source) => ({
    publicationPath: source.manifest.publicationPath,
    manifest: {
      byteLength: source.manifestByteLength,
      sha256: source.manifestSha256,
    },
    report: {
      originalPath: source.reportOriginalPath,
      role: source.reportRole,
      mediaType: source.reportMediaType,
      objectPath: source.reportObjectPath,
      viewPath: source.reportViewPath,
      byteLength: source.reportByteLength,
      sha256: source.reportSha256,
    },
    metricBinding: {
      schema: source.metricBinding?.schema ?? null,
      sha256: source.metricBinding?.sha256 ?? null,
    },
    pngs: source.pngs.map((png) => ({ ...png })),
  }));
}

export async function loadReviewerAttestation(attestationPath) {
  const absolutePath = resolve(attestationPath);
  const fingerprint = await fingerprintRegularFile(absolutePath, {
    readOnly: true,
    singleLink: true,
  });
  const bytes = fingerprint.bytes;
  const document = JSON.parse(bytes.toString("utf8"));
  return {
    path: absolutePath,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    documentCanonicalSha256: sha256(canonicalJson(document)),
    document,
    immutableSnapshots: [snapshotFingerprint(fingerprint)],
  };
}

export function validateReviewerAttestation(
  attestation,
  expectedSources,
  { latestPublicationAt, finalizedAt },
) {
  const failures = [];
  const document = attestation?.document;
  if (
    !exactKeys(document, [
      "schema",
      "schemaVersion",
      "campaign",
      "reviewer",
      "reviewedAt",
      "verdict",
      "findings",
      "sources",
    ]) ||
    document.schema !== C12_33_REVIEW_SCHEMA ||
    document.schemaVersion !== 1 ||
    document.campaign !== "C12-33"
  ) {
    failures.push("reviewer attestation schema is invalid");
    return failures;
  }
  if (
    !exactKeys(document.reviewer, ["identity"]) ||
    !TOKEN_PATTERN.test(document.reviewer.identity ?? "")
  ) {
    failures.push("reviewer identity is missing or invalid");
  }
  if (!canonicalTimestamp(document.reviewedAt)) {
    failures.push("reviewer timestamp is not canonical ISO-8601");
  } else {
    if (document.reviewedAt < latestPublicationAt) {
      failures.push("review predates one or more source publications");
    }
    if (document.reviewedAt > finalizedAt) {
      failures.push("review timestamp is later than finalization");
    }
  }
  if (!HASH_PATTERN.test(attestation?.sha256 ?? "")) {
    failures.push("reviewer attestation byte hash is invalid");
  }
  if (
    !HASH_PATTERN.test(attestation?.documentCanonicalSha256 ?? "") ||
    attestation.documentCanonicalSha256 !== sha256(canonicalJson(document))
  ) {
    failures.push(
      "reviewer attestation document changed after its immutable read",
    );
  }
  if (!sameJson(document.sources, expectedSources)) {
    failures.push(
      "reviewer attestation does not bind every manifest/report/PNG hash",
    );
  }
  if (
    !Array.isArray(document.findings) ||
    document.findings.length !== C12_33_REVIEW_FINDINGS.length
  ) {
    failures.push("reviewer findings do not contain the fixed three checks");
  } else {
    document.findings.forEach((finding, index) => {
      if (
        !exactKeys(finding, ["id", "verdict", "notes"]) ||
        finding.id !== C12_33_REVIEW_FINDINGS[index] ||
        !["PASS", "FAIL"].includes(finding.verdict) ||
        typeof finding.notes !== "string" ||
        finding.notes.trim().length === 0
      ) {
        failures.push(`reviewer finding ${index} is invalid`);
      }
    });
  }
  if (!["PASS", "FAIL"].includes(document.verdict)) {
    failures.push("reviewer verdict must be PASS or FAIL");
  }
  if (
    document.verdict === "PASS" &&
    Array.isArray(document.findings) &&
    document.findings.some((finding) => finding.verdict !== "PASS")
  ) {
    failures.push("reviewer PASS conflicts with a non-PASS finding");
  }
  return failures;
}

function finiteMetric(values, path) {
  if (
    values.length !== 5 ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error(`${path} did not retain five finite non-negative values`);
  }
  return values;
}

export function deriveC1233CalibratedThresholds(normalReports) {
  if (!Array.isArray(normalReports) || normalReports.length !== 5) {
    throw new Error("calibration requires exactly five normal reports");
  }
  const laneMaps = normalReports.map(
    (report) => new Map(report.lanes.map((lane) => [lane.id, lane])),
  );
  const lanes = {};
  for (const laneDefinition of MOON_MIP_MOTION_LANES) {
    const laneId = laneDefinition.id;
    const laneThresholds = {};
    for (const backend of BACKENDS) {
      const temporal = {};
      for (const [thresholdKey, measurementKey] of TEMPORAL_MAXIMUM_METRICS) {
        const values = finiteMetric(
          laneMaps.map(
            (laneMap) =>
              laneMap.get(laneId)?.backends?.[backend]?.temporal?.[
                measurementKey
              ],
          ),
          `${laneId}/${backend}/${measurementKey}`,
        );
        temporal[thresholdKey] = Math.max(...values);
      }
      const spatial = {};
      for (const [minimumKey, maximumKey, measurementKey] of SPATIAL_BANDS) {
        const values = finiteMetric(
          laneMaps.map(
            (laneMap) =>
              laneMap.get(laneId)?.backends?.[backend]?.spatial?.[
                measurementKey
              ],
          ),
          `${laneId}/${backend}/${measurementKey}`,
        );
        spatial[minimumKey] = Math.min(...values);
        spatial[maximumKey] = Math.max(...values);
      }
      laneThresholds[backend] = { temporal, spatial };
    }
    const parity = {};
    for (const [thresholdKey, measurementKey, direction] of PARITY_BOUNDS) {
      const values = finiteMetric(
        laneMaps.map(
          (laneMap) => laneMap.get(laneId)?.parity?.[measurementKey],
        ),
        `${laneId}/parity/${measurementKey}`,
      );
      parity[thresholdKey] =
        direction === "minimum" ? Math.min(...values) : Math.max(...values);
    }
    lanes[laneId] = { ...laneThresholds, parity };
  }
  const thresholds = { schemaVersion: 1, lanes };
  const failures = validateCalibratedThresholds(thresholds);
  if (failures.length > 0) {
    throw new Error(`derived thresholds are invalid: ${failures.join("; ")}`);
  }
  return thresholds;
}

export function countThresholdValues(thresholds) {
  let count = 0;
  const visit = (value) => {
    if (typeof value === "number") {
      count++;
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key !== "schemaVersion") {
          visit(child);
        }
      }
    }
  };
  visit(thresholds);
  return count;
}

function orderedSources(sources, structuralFailures) {
  if (!Array.isArray(sources) || sources.length !== 10) {
    structuralFailures.push(
      "finalization requires exactly ten published raw runs",
    );
    return [];
  }
  const ordered = [...sources].sort((left, right) => {
    const timeOrder = String(left.report?.capturedAt).localeCompare(
      String(right.report?.capturedAt),
    );
    return (
      timeOrder ||
      String(left.report?.runId).localeCompare(String(right.report?.runId))
    );
  });
  const runIds = new Set();
  const publicationPaths = new Set();
  for (const source of ordered) {
    if (source.publicationVerified !== true) {
      structuralFailures.push(
        `source ${source.report?.runId ?? "unknown"} was not loaded through publication verification`,
      );
    }
    appendUnique(
      structuralFailures,
      validateLoadedSourceIdentity(source).map(
        (failure) => `source ${source.report?.runId ?? "unknown"}: ${failure}`,
      ),
    );
    appendUnique(structuralFailures, validateRawMoonMipReport(source.report));
    if (runIds.has(source.report?.runId)) {
      structuralFailures.push(`duplicate raw run id ${source.report?.runId}`);
    }
    runIds.add(source.report?.runId);
    if (publicationPaths.has(source.manifest?.publicationPath)) {
      structuralFailures.push(
        `duplicate source publication ${source.manifest?.publicationPath}`,
      );
    }
    publicationPaths.add(source.manifest?.publicationPath);
  }
  for (let index = 1; index < ordered.length; index++) {
    if (
      ordered[index - 1].report.capturedAt === ordered[index].report.capturedAt
    ) {
      structuralFailures.push(
        "raw reports must have distinct capture timestamps",
      );
    }
  }
  return ordered;
}

function validateFixedSchedule(ordered, structuralFailures) {
  const actual = ordered.map((source) => source.report.controlMode);
  if (!sameJson(actual, C12_33_COUNTERBALANCED_CONTROL_ORDER)) {
    structuralFailures.push(
      `chronological control order must be ${C12_33_COUNTERBALANCED_CONTROL_ORDER.join(",")}`,
    );
  }
}

function validateSharedIdentity(ordered, structuralFailures) {
  if (ordered.length === 0) {
    return;
  }
  const reference = ordered[0];
  const identities = [
    ["fixedTimeIso", (source) => source.report.fixedTimeIso],
    ["sampleCount", (source) => source.report.sampleCount],
    ["viewerUrl", (source) => source.report.viewerUrl],
    ["browser", (source) => source.report.browser],
    ["runtimeIdentity", (source) => source.report.runtimeIdentity],
    ["setup", (source) => source.report.setup],
    ["repository", sourceRepositoryIdentity],
  ];
  for (const [label, select] of identities) {
    const expected = select(reference);
    for (const source of ordered.slice(1)) {
      if (!sameJson(select(source), expected)) {
        structuralFailures.push(
          `raw run ${source.report.runId} does not share exact ${label}`,
        );
      }
    }
  }
}

function calibrationPairs(ordered) {
  const pairs = [];
  for (let index = 0; index < ordered.length; index += 2) {
    const first = ordered[index];
    const second = ordered[index + 1];
    const normal = first.report.controlMode === "normal" ? first : second;
    const control = first.report.controlMode === "force-lod0" ? first : second;
    pairs.push({ first, second, normal, control });
  }
  return pairs;
}

function validateLoadedSourceIdentity(source) {
  const failures = validateManifestShape(source?.manifest);
  if (
    !HASH_PATTERN.test(source?.manifestSha256 ?? "") ||
    !Number.isInteger(source?.manifestByteLength) ||
    source.manifestByteLength <= 0 ||
    !HASH_PATTERN.test(source?.reportSha256 ?? "") ||
    !HASH_PATTERN.test(source?.manifestCanonicalSha256 ?? "") ||
    source.manifestCanonicalSha256 !== sha256(canonicalJson(source.manifest)) ||
    !HASH_PATTERN.test(source?.reportCanonicalSha256 ?? "") ||
    source.reportCanonicalSha256 !== sha256(canonicalJson(source.report)) ||
    !Number.isInteger(source?.reportByteLength) ||
    source.reportByteLength <= 0
  ) {
    failures.push("loaded source manifest/report byte identity is invalid");
  }
  if (
    !exactKeys(source?.metricBinding, ["schema", "sha256"]) ||
    source.metricBinding.schema !== PNG_METRIC_BINDING_SCHEMA ||
    source.metricBinding.sha256 !== moonMipMetricBindingSha256(source?.report)
  ) {
    failures.push(
      "loaded source decoded-PNG metric binding is absent or disagrees",
    );
  }
  if (
    source?.manifest?.runId !== source?.report?.runId ||
    source?.manifest?.result?.status !== source?.report?.status ||
    source?.manifest?.result?.exitCode !== source?.report?.exitCode ||
    source?.manifest?.result?.certificationEligible !==
      source?.report?.certificationEligible ||
    !canonicalTimestamp(source?.manifest?.publishedAt) ||
    !canonicalTimestamp(source?.report?.capturedAt) ||
    source.manifest.publishedAt < source.report.capturedAt
  ) {
    failures.push("loaded source publication/report result identity disagrees");
  }
  const manifestOriginals = new Set();
  for (const entry of source?.manifest?.files ?? []) {
    let pathValid = true;
    try {
      portablePath(entry?.originalPath, "manifest file originalPath");
    } catch (_error) {
      pathValid = false;
    }
    const expectedViewPath = pathValid
      ? posix.join("files", entry.originalPath)
      : null;
    const expectedObjectPath = HASH_PATTERN.test(entry?.sha256 ?? "")
      ? posix.join("objects", "sha256", entry.sha256.slice(0, 2), entry.sha256)
      : null;
    const folded = String(entry?.originalPath).toLocaleLowerCase("en-US");
    if (
      !exactKeys(entry, FILE_ENTRY_KEYS) ||
      !pathValid ||
      manifestOriginals.has(folded) ||
      !["artifact", "file"].includes(entry?.role) ||
      entry?.mediaType !== expectedMediaType(entry?.originalPath ?? "") ||
      entry?.viewPath !== expectedViewPath ||
      entry?.objectPath !== expectedObjectPath ||
      !Number.isInteger(entry?.byteLength) ||
      entry.byteLength < 0 ||
      !validCaptureIdentity(
        entry?.sourcePre,
        entry?.sha256,
        entry?.byteLength,
      ) ||
      !validCaptureIdentity(
        entry?.sourcePost,
        entry?.sha256,
        entry?.byteLength,
      ) ||
      !sameCaptureIdentity(entry?.sourcePre, entry?.sourcePost)
    ) {
      failures.push("loaded source manifest file binding is invalid");
    }
    manifestOriginals.add(folded);
  }
  if (!Array.isArray(source?.pngs) || source.pngs.length !== 104) {
    failures.push(
      "loaded source does not retain exactly 104 verified PNG identities",
    );
    return failures;
  }
  const pngByOriginalPath = new Map();
  for (const png of source.pngs) {
    if (
      !exactKeys(png, [
        "originalPath",
        "role",
        "mediaType",
        "objectPath",
        "viewPath",
        "byteLength",
        "sha256",
      ]) ||
      typeof png?.originalPath !== "string" ||
      png.role !== "file" ||
      png.mediaType !== "image/png" ||
      !HASH_PATTERN.test(png?.sha256 ?? "") ||
      !Number.isInteger(png?.byteLength) ||
      png.byteLength <= 0 ||
      pngByOriginalPath.has(png.originalPath)
    ) {
      failures.push(
        "loaded source contains a malformed or duplicate PNG identity",
      );
      continue;
    }
    pngByOriginalPath.set(png.originalPath, png);
  }
  const reportDirectory = posix.dirname(source.reportOriginalPath ?? "");
  for (const frame of reportPngFrames(source.report)) {
    const originalPath = posix.normalize(
      posix.join(reportDirectory, frame.pngPath),
    );
    if (pngByOriginalPath.get(originalPath)?.sha256 !== frame.pngSha256) {
      failures.push(
        `loaded PNG identity disagrees with raw report: ${originalPath}`,
      );
    }
  }
  const manifestFileByOriginalPath = new Map(
    (source.manifest?.files ?? []).map((entry) => [entry.originalPath, entry]),
  );
  const reportEntry = manifestFileByOriginalPath.get(source.reportOriginalPath);
  if (
    reportEntry?.sha256 !== source.reportSha256 ||
    reportEntry?.byteLength !== source.reportByteLength ||
    reportEntry?.mediaType !== "application/json" ||
    reportEntry?.role !== "artifact" ||
    reportEntry?.viewPath !== source.reportViewPath ||
    reportEntry?.objectPath !== source.reportObjectPath ||
    source.reportRole !== "artifact" ||
    source.reportMediaType !== "application/json"
  ) {
    failures.push(
      "manifest report entry disagrees with loaded report identity",
    );
  }
  for (const png of source.pngs) {
    const entry = manifestFileByOriginalPath.get(png.originalPath);
    if (
      entry?.sha256 !== png.sha256 ||
      entry?.byteLength !== png.byteLength ||
      entry?.mediaType !== "image/png" ||
      entry?.role !== "file" ||
      entry?.viewPath !== png.viewPath ||
      entry?.objectPath !== png.objectPath
    ) {
      failures.push(
        `manifest PNG entry disagrees with loaded identity: ${png.originalPath}`,
      );
    }
  }
  return failures;
}

function foldC1233MoonMipMotionEvidenceInternal({
  sources,
  reviewerAttestation,
  finalizedAt = new Date().toISOString(),
}) {
  const structuralFailures = [];
  const acceptanceFailures = [];
  if (!canonicalTimestamp(finalizedAt)) {
    structuralFailures.push("finalizedAt is not canonical ISO-8601");
  }
  const ordered = orderedSources(sources, structuralFailures);
  if (ordered.length === 10) {
    validateFixedSchedule(ordered, structuralFailures);
    validateSharedIdentity(ordered, structuralFailures);
    appendUnique(
      structuralFailures,
      validateC1233PreregistrationCustody(
        ordered.map((source) => source.report),
      ),
    );
  }
  const pairs = ordered.length === 10 ? calibrationPairs(ordered) : [];
  const pairResults = [];
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    const sensitivity = evaluatePairedReportSensitivity(
      pair.normal.report,
      pair.control.report,
    );
    pairResults.push({
      pair: index + 1,
      captureOrder: [
        pair.first.report.controlMode,
        pair.second.report.controlMode,
      ],
      runIds: [pair.first.report.runId, pair.second.report.runId],
      normalRunId: pair.normal.report.runId,
      forceLod0RunId: pair.control.report.runId,
      sensitivity,
    });
    if (!sensitivity.sensitive) {
      appendUnique(
        acceptanceFailures,
        sensitivity.failures.map((failure) => `pair ${index + 1}: ${failure}`),
      );
    }
  }

  let thresholds = null;
  let thresholdValueCount = 0;
  let normalQuality = [];
  if (pairs.length === 5) {
    try {
      thresholds = deriveC1233CalibratedThresholds(
        pairs.map((pair) => pair.normal.report),
      );
      thresholdValueCount = countThresholdValues(thresholds);
      if (thresholdValueCount !== 88) {
        structuralFailures.push(
          `calibration produced ${thresholdValueCount} threshold values instead of 88`,
        );
      }
      normalQuality = pairs.map((pair) => ({
        runId: pair.normal.report.runId,
        failures: evaluateCalibratedQuality(pair.normal.report, thresholds),
      }));
      for (const quality of normalQuality) {
        appendUnique(
          acceptanceFailures,
          quality.failures.map(
            (failure) => `normal run ${quality.runId}: ${failure}`,
          ),
        );
      }
    } catch (error) {
      structuralFailures.push(String(error?.message ?? error));
    }
  }

  const bindings = ordered.length === 10 ? reviewerSourceBindings(ordered) : [];
  const latestPublicationAt = ordered.reduce(
    (latest, source) =>
      source.manifest.publishedAt > latest
        ? source.manifest.publishedAt
        : latest,
    "",
  );
  const reviewPending = reviewerAttestation == null;
  if (!reviewPending) {
    const reviewFailures = validateReviewerAttestation(
      reviewerAttestation,
      bindings,
      { latestPublicationAt, finalizedAt },
    );
    appendUnique(structuralFailures, reviewFailures);
    if (reviewerAttestation?.document?.verdict !== "PASS") {
      acceptanceFailures.push("independent reviewer verdict is not PASS");
    }
    for (const finding of reviewerAttestation?.document?.findings ?? []) {
      if (finding.verdict !== "PASS") {
        acceptanceFailures.push(`reviewer finding is not PASS: ${finding.id}`);
      }
    }
  }

  const status =
    structuralFailures.length > 0
      ? "STRUCTURAL"
      : acceptanceFailures.length > 0
        ? "FAIL"
        : reviewPending
          ? "PENDING-REVIEW"
          : "PASS";
  const exitCode =
    status === "PASS"
      ? EXIT_CODES.PASS
      : status === "FAIL"
        ? EXIT_CODES.FAIL
        : EXIT_CODES.STRUCTURAL;
  return {
    schema: C12_33_CERTIFICATION_SCHEMA,
    schemaVersion: 1,
    campaign: "C12-33",
    certificationClaim: C12_33_SHIMMER_ENVELOPE_CERTIFICATION,
    doesNotMeasure: [...C12_33_DOES_NOT_MEASURE],
    designId: MOON_MIP_PREREGISTRATION_DESIGN_ID,
    preregistrationSha256: computeMoonMipPreregistrationSha256(),
    filedDiscrepancy: C12_33_FILED_DESIGN_DISCREPANCY,
    producer: "moon-mip-motion-offline-finalizer",
    finalizedAt,
    status,
    exitCode,
    certificationEligible: status === "PASS" && exitCode === 0,
    structuralFailures,
    acceptanceFailures,
    calibration: {
      policy: C12_33_CALIBRATION_POLICY,
      pairCount: pairs.length,
      controlOrder: [...C12_33_COUNTERBALANCED_CONTROL_ORDER],
      sensitivityRequirements: PAIRED_SENSITIVITY_REQUIREMENTS.map(
        (requirement) => ({ ...requirement }),
      ),
      pairResults,
      thresholds,
      thresholdValueCount,
      normalQuality,
    },
    reviewer: reviewerAttestation
      ? {
          byteLength: reviewerAttestation.byteLength,
          sha256: reviewerAttestation.sha256,
          documentCanonicalSha256: reviewerAttestation.documentCanonicalSha256,
          identity: reviewerAttestation.document?.reviewer?.identity ?? null,
          reviewedAt: reviewerAttestation.document?.reviewedAt ?? null,
          verdict: reviewerAttestation.document?.verdict ?? null,
          findings: (reviewerAttestation.document?.findings ?? []).map(
            (finding) => ({ ...finding }),
          ),
        }
      : null,
    sources: bindings,
  };
}

function malformedFoldArtifact(error, finalizedAt) {
  const safeFinalizedAt = canonicalTimestamp(finalizedAt)
    ? finalizedAt
    : new Date().toISOString();
  return {
    schema: C12_33_CERTIFICATION_SCHEMA,
    schemaVersion: 1,
    campaign: "C12-33",
    certificationClaim: C12_33_SHIMMER_ENVELOPE_CERTIFICATION,
    doesNotMeasure: [...C12_33_DOES_NOT_MEASURE],
    designId: MOON_MIP_PREREGISTRATION_DESIGN_ID,
    preregistrationSha256: MOON_MIP_PREREGISTRATION_SHA256,
    filedDiscrepancy: C12_33_FILED_DESIGN_DISCREPANCY,
    producer: "moon-mip-motion-offline-finalizer",
    finalizedAt: safeFinalizedAt,
    status: "STRUCTURAL",
    exitCode: EXIT_CODES.FAIL,
    certificationEligible: false,
    structuralFailures: [
      `malformed finalizer input: ${String(error?.message ?? error)}`,
    ],
    acceptanceFailures: [],
    calibration: {
      policy: C12_33_CALIBRATION_POLICY,
      pairCount: 0,
      controlOrder: [...C12_33_COUNTERBALANCED_CONTROL_ORDER],
      sensitivityRequirements: PAIRED_SENSITIVITY_REQUIREMENTS.map(
        (requirement) => ({ ...requirement }),
      ),
      pairResults: [],
      thresholds: null,
      thresholdValueCount: 0,
      normalQuality: [],
    },
    reviewer: null,
    sources: [],
  };
}

export function foldC1233MoonMipMotionEvidence(input = {}) {
  try {
    return foldC1233MoonMipMotionEvidenceInternal(input);
  } catch (error) {
    return malformedFoldArtifact(error, input?.finalizedAt);
  }
}

export async function finalizeC1233MoonMipMotionFromPaths({
  manifestPaths,
  reviewerAttestationPath,
  finalizedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(manifestPaths) || manifestPaths.length !== 10) {
    throw new Error("exactly ten source publication manifests are required");
  }
  const sources = [];
  for (const manifestPath of manifestPaths) {
    sources.push(await loadPublishedMoonMipRun(manifestPath));
  }
  const reviewerAttestation = await loadReviewerAttestation(
    reviewerAttestationPath,
  );
  return foldC1233MoonMipMotionEvidence({
    sources,
    reviewerAttestation,
    finalizedAt,
  });
}

function pathContains(parent, child) {
  const childPath = relative(resolve(parent), resolve(child));
  return (
    childPath === "" ||
    (childPath !== ".." &&
      !childPath.startsWith(`..${sep}`) &&
      !isAbsolute(childPath))
  );
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

async function assertExistingAncestorsAreNonSymbolic(absolutePath) {
  const canonical = resolve(absolutePath);
  const root = parse(canonical).root;
  const components = relative(root, canonical).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let descriptor;
    try {
      descriptor = await lstat(current, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (descriptor.isSymbolicLink()) {
      throw new Error(
        `symbolic output ancestor is forbidden before mkdir: ${current}`,
      );
    }
    if (!descriptor.isDirectory()) {
      throw new Error(`output ancestor is not a directory: ${current}`);
    }
  }
}

async function prepareOutputPath(outputPath, immutablePaths) {
  const absoluteOutputPath = resolve(outputPath);
  for (const immutablePath of immutablePaths) {
    if (pathsOverlap(absoluteOutputPath, immutablePath)) {
      throw new Error(
        `finalizer output overlaps immutable input/publication: ${immutablePath}`,
      );
    }
  }
  const outputDirectory = dirname(absoluteOutputPath);
  await assertExistingAncestorsAreNonSymbolic(outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  await assertNoSymbolicComponents(outputDirectory);
  if (resolve(await realpath(outputDirectory)) !== outputDirectory) {
    throw new Error("finalizer output directory topology is not canonical");
  }
  try {
    await lstat(absoluteOutputPath);
    throw new Error(`finalizer output already exists: ${absoluteOutputPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return absoluteOutputPath;
}

async function atomicNoClobberWrite(
  outputPath,
  bytes,
  immutablePaths,
  beforeCommit,
) {
  const absoluteOutputPath = await prepareOutputPath(
    outputPath,
    immutablePaths,
  );
  const temporaryPath = join(
    dirname(absoluteOutputPath),
    `.${basename(absoluteOutputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await prepareOutputPath(absoluteOutputPath, immutablePaths);
    if (beforeCommit) {
      await beforeCommit();
    }
    await prepareOutputPath(absoluteOutputPath, immutablePaths);
    await link(temporaryPath, absoluteOutputPath);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
  return absoluteOutputPath;
}

function immutableInputTopology(sources, reviewerAttestation) {
  const paths = new Set([reviewerAttestation.path]);
  for (const source of sources) {
    paths.add(source.libraryRoot);
    paths.add(resolve(source.libraryRoot, "runs"));
    paths.add(resolve(source.libraryRoot, "objects"));
    paths.add(source.publicationDirectory);
    paths.add(source.manifestPath);
    for (const snapshot of source.immutableSnapshots ?? []) {
      paths.add(snapshot.path);
    }
    for (const snapshot of source.immutableDirectorySnapshots ?? []) {
      paths.add(snapshot.path);
    }
  }
  for (const snapshot of reviewerAttestation.immutableSnapshots ?? []) {
    paths.add(snapshot.path);
  }
  return [...paths];
}

function immutableSnapshots(sources, reviewerAttestation) {
  const byPath = new Map();
  for (const snapshot of [
    ...sources.flatMap((source) => source.immutableSnapshots ?? []),
    ...(reviewerAttestation.immutableSnapshots ?? []),
  ]) {
    const previous = byPath.get(snapshot.path);
    if (previous && !sameJson(previous, snapshot)) {
      throw new Error(
        `immutable snapshot identity conflicts: ${snapshot.path}`,
      );
    }
    byPath.set(snapshot.path, snapshot);
  }
  return [...byPath.values()];
}

function immutableDirectorySnapshots(sources) {
  const byPath = new Map();
  for (const snapshot of sources.flatMap(
    (source) => source.immutableDirectorySnapshots ?? [],
  )) {
    const previous = byPath.get(snapshot.path);
    if (previous && !sameJson(previous, snapshot)) {
      throw new Error(
        `immutable directory snapshot identity conflicts: ${snapshot.path}`,
      );
    }
    byPath.set(snapshot.path, snapshot);
  }
  return [...byPath.values()];
}

function sameSnapshotSets(left, right) {
  const ordered = (snapshots) =>
    snapshots
      .map((snapshot) => structuredClone(snapshot))
      .sort((a, b) => a.path.localeCompare(b.path));
  return sameJson(ordered(left), ordered(right));
}

function samePathSets(left, right) {
  return sameJson(
    [...new Set(left.map((path) => resolve(path)))].sort(),
    [...new Set(right.map((path) => resolve(path)))].sort(),
  );
}

export async function finalizeAndWriteC1233MoonMipMotion({
  outputPath,
  manifestPaths,
  reviewerAttestationPath,
  finalizedAt = new Date().toISOString(),
  onBeforeFinalRevalidation,
}) {
  if (!Array.isArray(manifestPaths) || manifestPaths.length !== 10) {
    throw new Error("exactly ten source publication manifests are required");
  }
  const lexicalLibraryRoots = manifestPaths.map((path) =>
    resolve(dirname(resolve(path)), "..", "..", ".."),
  );
  const lexicalInputs = [
    resolve(reviewerAttestationPath),
    ...manifestPaths.flatMap((path) => [resolve(path), dirname(resolve(path))]),
    ...lexicalLibraryRoots.flatMap((root) => [
      root,
      resolve(root, "runs"),
      resolve(root, "objects"),
    ]),
  ];
  await prepareOutputPath(outputPath, lexicalInputs);
  const sources = [];
  for (const manifestPath of manifestPaths) {
    sources.push(await loadPublishedMoonMipRun(manifestPath));
  }
  const reviewerAttestation = await loadReviewerAttestation(
    reviewerAttestationPath,
  );
  let artifact = foldC1233MoonMipMotionEvidence({
    sources,
    reviewerAttestation,
    finalizedAt,
  });
  const topology = immutableInputTopology(sources, reviewerAttestation);
  const snapshots = immutableSnapshots(sources, reviewerAttestation);
  const directorySnapshots = immutableDirectorySnapshots(sources);
  await prepareOutputPath(outputPath, topology);
  if (onBeforeFinalRevalidation) {
    await onBeforeFinalRevalidation({ sources, reviewerAttestation });
  }
  const serialize = () => Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  if (artifact.status === "PASS") {
    try {
      await atomicNoClobberWrite(
        outputPath,
        serialize(),
        topology,
        async () => {
          const reloadedSources = [];
          for (const manifestPath of manifestPaths) {
            reloadedSources.push(await loadPublishedMoonMipRun(manifestPath));
          }
          const reloadedReviewerAttestation = await loadReviewerAttestation(
            reviewerAttestationPath,
          );
          const reloadedSnapshots = immutableSnapshots(
            reloadedSources,
            reloadedReviewerAttestation,
          );
          const reloadedDirectorySnapshots =
            immutableDirectorySnapshots(reloadedSources);
          if (
            !sameSnapshotSets(snapshots, reloadedSnapshots) ||
            !sameSnapshotSets(directorySnapshots, reloadedDirectorySnapshots)
          ) {
            throw new Error(
              "immutable publication/reviewer topology or content drifted before PASS",
            );
          }
          const reloadedTopology = immutableInputTopology(
            reloadedSources,
            reloadedReviewerAttestation,
          );
          if (!samePathSets(topology, reloadedTopology)) {
            throw new Error(
              "immutable publication topology paths drifted before PASS",
            );
          }
          const refolded = foldC1233MoonMipMotionEvidence({
            sources: reloadedSources,
            reviewerAttestation: reloadedReviewerAttestation,
            finalizedAt,
          });
          if (refolded.status !== "PASS" || !sameJson(refolded, artifact)) {
            throw new Error(
              "immutable publication/reviewer refold changed before PASS",
            );
          }
          await revalidateImmutableSnapshots(reloadedSnapshots);
          await revalidateImmutableDirectorySnapshots(
            reloadedDirectorySnapshots,
          );
        },
      );
      return artifact;
    } catch (error) {
      artifact = {
        ...artifact,
        status: "STRUCTURAL",
        exitCode: EXIT_CODES.FAIL,
        certificationEligible: false,
        structuralFailures: [
          ...artifact.structuralFailures,
          `immutable pre-PASS revalidation failed: ${String(error?.message ?? error)}`,
        ],
      };
    }
  }
  await atomicNoClobberWrite(outputPath, serialize(), topology);
  return artifact;
}

async function runCli() {
  const [outputPathArgument, attestationPath, ...manifestPaths] =
    process.argv.slice(2);
  if (!outputPathArgument || !attestationPath || manifestPaths.length !== 10) {
    throw new Error(
      "usage: node moon-mip-motion-certification.mjs OUTPUT REVIEW_ATTESTATION MANIFEST_1 ... MANIFEST_10",
    );
  }
  const artifact = await finalizeAndWriteC1233MoonMipMotion({
    outputPath: outputPathArgument,
    manifestPaths,
    reviewerAttestationPath: attestationPath,
  });
  console.log(JSON.stringify(artifact, null, 2));
  process.exitCode = artifact.exitCode;
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli().catch(async (error) => {
    const outputPathArgument = process.argv[2];
    const fatalArtifact = {
      schema: C12_33_CERTIFICATION_SCHEMA,
      schemaVersion: 1,
      campaign: "C12-33",
      certificationClaim: C12_33_SHIMMER_ENVELOPE_CERTIFICATION,
      doesNotMeasure: [...C12_33_DOES_NOT_MEASURE],
      designId: MOON_MIP_PREREGISTRATION_DESIGN_ID,
      preregistrationSha256: MOON_MIP_PREREGISTRATION_SHA256,
      filedDiscrepancy: C12_33_FILED_DESIGN_DISCREPANCY,
      producer: "moon-mip-motion-offline-finalizer",
      finalizedAt: new Date().toISOString(),
      status: "ERROR",
      exitCode: EXIT_CODES.FAIL,
      certificationEligible: false,
      structuralFailures: [String(error?.message ?? error)],
      acceptanceFailures: [],
    };
    if (outputPathArgument) {
      const manifestArguments = process.argv
        .slice(4)
        .map((path) => resolve(path));
      const immutableInputs = [
        resolve(process.argv[3] ?? "."),
        ...manifestArguments,
        ...manifestArguments.map((path) => dirname(path)),
      ];
      try {
        await atomicNoClobberWrite(
          outputPathArgument,
          Buffer.from(`${JSON.stringify(fatalArtifact, null, 2)}\n`),
          immutableInputs,
        );
      } catch (_writeError) {
        // The original finalization failure remains authoritative.
      }
    }
    console.error(error?.stack ?? error);
    process.exitCode = EXIT_CODES.FAIL;
  });
}
