import { createHash } from "node:crypto";

export const GateStatus = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  NON_CERTIFYING: "NON_CERTIFYING",
});

const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  "scene",
  "image",
  "imageSha256",
  "renderer",
  "provenanceClass",
  "sourceCommit",
  "sourceDirty",
  "width",
  "height",
  "sceneIdentity",
  "browserClass",
  "browserVersion",
  "adapterClass",
  "capturedAt",
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createSceneIdentity(scene, runConfiguration) {
  const identity = {
    name: scene.name,
    camera: scene.camera ?? null,
    setup: scene.setup ?? null,
    setupFile: scene.setupFile ?? null,
    setupParams: scene.setupParams ?? null,
    baseUrl: runConfiguration.baseUrl,
    settleFrames: runConfiguration.settleFrames,
    viewport: runConfiguration.viewport,
  };
  return sha256(stableStringify(identity));
}

function thresholdOrFallback(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function resolveSceneThresholds(scene, fallback) {
  const thresholds = scene.thresholds ?? {};
  return {
    historicalWebgl: thresholdOrFallback(thresholds.historicalWebgl, fallback),
    historicalWebgpu: thresholdOrFallback(
      thresholds.historicalWebgpu,
      fallback,
    ),
    crossBackend: thresholdOrFallback(thresholds.crossBackend, fallback),
  };
}

export function compareCaptures(current, reference, tolerance = 16) {
  if (
    current.width !== reference.width ||
    current.height !== reference.height
  ) {
    throw new Error(
      `Dimension mismatch: ${current.width}x${current.height} vs ${reference.width}x${reference.height}`,
    );
  }

  const a = new Uint8ClampedArray(current.data);
  const b = new Uint8ClampedArray(reference.data);
  const expectedLength = current.width * current.height * 4;
  if (a.length !== expectedLength || b.length !== expectedLength) {
    throw new Error(
      `Invalid RGBA length: expected ${expectedLength}, got ${a.length} and ${b.length}`,
    );
  }
  if (a.length !== b.length) {
    throw new Error(`Buffer length mismatch: ${a.length} vs ${b.length}`);
  }

  const diff = new Uint8ClampedArray(a.length);
  let mismatches = 0;
  const totalPixels = current.width * current.height;
  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    if (dr > tolerance || dg > tolerance || db > tolerance) {
      mismatches++;
      diff[i] = 255;
      diff[i + 1] = 0;
      diff[i + 2] = 0;
      diff[i + 3] = 255;
    } else {
      const dim = ((a[i] + a[i + 1] + a[i + 2]) / 3) * 0.25;
      diff[i] = dim;
      diff[i + 1] = dim;
      diff[i + 2] = dim;
      diff[i + 3] = 255;
    }
  }
  return { diff, ratio: mismatches / totalPixels };
}

export function validateManifestEntry(entry, actual) {
  const reasons = [];
  if (!entry || typeof entry !== "object") {
    return { certifying: false, reasons: ["MANIFEST_ENTRY_MISSING"] };
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (
      entry[field] === undefined ||
      entry[field] === null ||
      entry[field] === ""
    ) {
      reasons.push(`MANIFEST_FIELD_MISSING:${field}`);
    }
  }

  if (entry.review?.status !== "approved") {
    reasons.push("MANIFEST_REVIEW_NOT_APPROVED");
  }
  if (entry.provenanceClass !== "accepted-current") {
    reasons.push("MANIFEST_PROVENANCE_NOT_ACCEPTED_CURRENT");
  }
  if (entry.sourceDirty !== false) {
    reasons.push("MANIFEST_SOURCE_DIRTY");
  }
  if (
    !entry.review?.reviewedBy ||
    !entry.review?.rationale ||
    !entry.review?.reviewedAt
  ) {
    reasons.push("MANIFEST_REVIEW_INCOMPLETE");
  }
  if (!/^[0-9a-f]{40}$/i.test(entry.sourceCommit ?? "")) {
    reasons.push("MANIFEST_SOURCE_COMMIT_INVALID");
  }
  if (!/^[0-9a-f]{64}$/i.test(entry.imageSha256 ?? "")) {
    reasons.push("MANIFEST_IMAGE_SHA_INVALID");
  }
  if (!/^[0-9a-f]{64}$/i.test(entry.sceneIdentity ?? "")) {
    reasons.push("MANIFEST_SCENE_IDENTITY_INVALID");
  }

  const matchingFields = [
    "scene",
    "image",
    "imageSha256",
    "renderer",
    "width",
    "height",
    "sceneIdentity",
    "browserClass",
    "adapterClass",
  ];
  for (const field of matchingFields) {
    if (entry[field] !== actual[field]) {
      reasons.push(`MANIFEST_MISMATCH:${field}`);
    }
  }
  if (actual.adapterClass === "unknown") {
    reasons.push("RUNTIME_ADAPTER_CLASS_UNKNOWN");
  }

  return { certifying: reasons.length === 0, reasons };
}

export function evaluatePixelGate({
  id,
  current,
  reference,
  threshold,
  manifestValidation,
}) {
  if (!reference) {
    return {
      gate: {
        id,
        status: GateStatus.NON_CERTIFYING,
        comparisonStatus: "NOT_RUN",
        certifying: false,
        historicalAvailable: false,
        historicalCertifying: false,
        ratio: null,
        threshold,
        reasons: ["HISTORICAL_BASELINE_MISSING"],
      },
      diff: null,
    };
  }

  let comparison;
  try {
    comparison = compareCaptures(current, reference);
  } catch (error) {
    const historicalGate = manifestValidation !== undefined;
    const historicalCertifying = manifestValidation?.certifying ?? true;
    return {
      gate: {
        id,
        status: historicalCertifying
          ? GateStatus.FAIL
          : GateStatus.NON_CERTIFYING,
        comparisonStatus: GateStatus.FAIL,
        certifying: false,
        historicalAvailable: historicalGate ? true : undefined,
        historicalCertifying: historicalGate ? historicalCertifying : undefined,
        ratio: null,
        threshold,
        reasons: [
          ...(manifestValidation?.reasons ?? []),
          `COMPARISON_ERROR:${error.message}`,
        ],
      },
      diff: null,
    };
  }

  const comparisonStatus =
    comparison.ratio <= threshold ? GateStatus.PASS : GateStatus.FAIL;
  const historicalGate = manifestValidation !== undefined;
  const historicalCertifying = manifestValidation?.certifying ?? true;
  const status = historicalCertifying
    ? comparisonStatus
    : GateStatus.NON_CERTIFYING;
  return {
    gate: {
      id,
      status,
      comparisonStatus,
      certifying: status === GateStatus.PASS,
      historicalAvailable: historicalGate ? true : undefined,
      historicalCertifying: historicalGate ? historicalCertifying : undefined,
      ratio: comparison.ratio,
      threshold,
      reasons: historicalCertifying ? [] : manifestValidation.reasons,
    },
    diff: comparison.diff,
  };
}

export function summarizeSceneGates(gates) {
  const values = Object.values(gates);
  const status = values.some((gate) => gate.status === GateStatus.FAIL)
    ? GateStatus.FAIL
    : values.some((gate) => gate.status === GateStatus.NON_CERTIFYING)
      ? GateStatus.NON_CERTIFYING
      : GateStatus.PASS;
  return {
    status,
    certifying: status === GateStatus.PASS,
    gateCounts: Object.fromEntries(
      Object.values(GateStatus).map((gateStatus) => [
        gateStatus,
        values.filter((gate) => gate.status === gateStatus).length,
      ]),
    ),
  };
}

export function validatePromotionRequest(args) {
  if (!args.update) {
    return { requested: false, authorized: false, errors: [] };
  }

  const errors = [];
  if (!args.confirmBaselinePromotion) {
    errors.push("--confirm-baseline-promotion is required with --update");
  }
  if (!args.updateRationale?.trim()) {
    errors.push("--update-rationale is required with --update");
  }
  if (!args.reviewedBy?.trim()) {
    errors.push("--reviewed-by is required with --update");
  }
  return {
    requested: true,
    authorized: errors.length === 0,
    errors,
  };
}
