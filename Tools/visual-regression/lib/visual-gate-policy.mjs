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
  const hasSetupFile = typeof scene.setupFile === "string";
  const setupFileSha256 = runConfiguration.setupFileSha256 ?? null;
  if (hasSetupFile && !/^[0-9a-f]{64}$/i.test(setupFileSha256 ?? "")) {
    throw new Error(
      `Scene ${scene.name ?? "<unnamed>"} requires setupFileSha256`,
    );
  }
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
  if (hasSetupFile) {
    identity.setupFileSha256 = setupFileSha256;
  }
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

/**
 * The three gates every scene is evaluated against, in report order.
 */
export const GATE_IDS = Object.freeze([
  "historicalWebgl",
  "historicalWebgpu",
  "crossBackend",
]);

/**
 * What a scene may pre-register about a gate's outcome.
 *
 * `UNMEASURED` is a first-class value, not a placeholder: a scene added for a
 * subsystem that has never been measured in THIS metric has no honest
 * prediction to make, and inventing one by transcribing a number from a probe
 * that measures something else is worse than admitting the gap.
 */
export const GateExpectation = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  UNMEASURED: "UNMEASURED",
});

/** Outcome of comparing a pre-registered expectation against the real gate. */
export const ExpectationOutcome = Object.freeze({
  MET: "MET",
  UNMET: "UNMET",
  FIRST_RECORD: "FIRST_RECORD",
});

/**
 * Read a scene's `expectedMismatch` declarations.
 *
 * WHY THIS EXISTS, AND WHAT IT DELIBERATELY CANNOT DO. Two of the scenes this
 * was written for sit on top of filed, open defects; their cross-backend gate
 * is expected to be red until the defect is fixed. The two ways to record that
 * without this field are both bad: widen the scene's threshold until the red
 * turns green (which normalizes the defect and silently absorbs any WORSENING
 * of it), or leave the red unannotated (in which case a reviewer of
 * `report.json` cannot tell a known defect from a fresh regression).
 *
 * So an expectation is DOCUMENTATION THAT IS CHECKED. It is folded into the
 * report and printed next to the gate, and it never touches `status`,
 * `certifying`, or the process exit code — a red scene stays red. What it adds
 * is the third signal the suite could not previously express: an expectation
 * that is UNMET, which is either a new regression (predicted PASS, got FAIL)
 * or a defect that has been fixed without anyone updating the record
 * (predicted FAIL, got PASS). Both are findings.
 *
 * A predicted FAIL must name a tracker ID. That rule is what stops the field
 * becoming the very thing it replaces: "expected to fail" with no filed row
 * behind it is threshold-widening with extra steps.
 *
 * @param {object} scene manifest entry
 * @returns {{byGate: object, errors: string[]}}
 */
export function resolveSceneExpectations(scene) {
  const declared = scene?.expectedMismatch;
  const sceneName = scene?.name ?? "<unnamed>";
  if (declared === undefined || declared === null) {
    return { byGate: {}, errors: [] };
  }
  if (!Array.isArray(declared)) {
    return { byGate: {}, errors: [`EXPECTATION_NOT_ARRAY:${sceneName}`] };
  }

  const byGate = {};
  const errors = [];
  for (const [index, entry] of declared.entries()) {
    const where = `${sceneName}[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`EXPECTATION_ENTRY_INVALID:${where}`);
      continue;
    }
    if (!GATE_IDS.includes(entry.gate)) {
      errors.push(`EXPECTATION_GATE_UNKNOWN:${where}:${entry.gate}`);
      continue;
    }
    if (byGate[entry.gate] !== undefined) {
      errors.push(`EXPECTATION_GATE_DUPLICATED:${where}:${entry.gate}`);
      continue;
    }
    if (!Object.values(GateExpectation).includes(entry.expect)) {
      errors.push(`EXPECTATION_VALUE_UNKNOWN:${where}:${entry.expect}`);
      continue;
    }
    const rationale =
      typeof entry.rationale === "string" ? entry.rationale.trim() : "";
    if (rationale.length === 0) {
      errors.push(`EXPECTATION_RATIONALE_MISSING:${where}`);
      continue;
    }
    const trackedBy =
      typeof entry.trackedBy === "string" ? entry.trackedBy.trim() : "";
    if (entry.expect === GateExpectation.FAIL && trackedBy.length === 0) {
      errors.push(`EXPECTATION_TRACKER_MISSING:${where}`);
      continue;
    }
    byGate[entry.gate] = {
      gate: entry.gate,
      expect: entry.expect,
      trackedBy: trackedBy.length > 0 ? trackedBy : null,
      rationale,
    };
  }
  return { byGate, errors };
}

/**
 * Attach an expectation's outcome to a gate result.
 *
 * Returns a NEW gate object carrying an `expectation` field and nothing else
 * changed. `status` and `certifying` are copied through untouched, which is
 * the property the whole mechanism rests on.
 */
export function annotateGateExpectation(gate, expectation) {
  if (!expectation) {
    return { ...gate, expectation: null };
  }
  const outcome =
    expectation.expect === GateExpectation.UNMEASURED
      ? ExpectationOutcome.FIRST_RECORD
      : gate.status === expectation.expect
        ? ExpectationOutcome.MET
        : ExpectationOutcome.UNMET;
  return { ...gate, expectation: { ...expectation, outcome } };
}

/**
 * Count expectation outcomes across every gate of every scene in a report.
 * `unmet` is the number a reviewer reads first — it is the count of gates
 * whose behaviour contradicts what the manifest claims about them.
 */
export function summarizeExpectations(scenes) {
  const counts = {
    declared: 0,
    [ExpectationOutcome.MET]: 0,
    [ExpectationOutcome.UNMET]: 0,
    [ExpectationOutcome.FIRST_RECORD]: 0,
  };
  const unmet = [];
  for (const scene of scenes ?? []) {
    for (const gate of Object.values(scene.gates ?? {})) {
      const expectation = gate.expectation;
      if (!expectation) continue;
      counts.declared++;
      counts[expectation.outcome]++;
      if (expectation.outcome === ExpectationOutcome.UNMET) {
        unmet.push({
          scene: scene.name,
          gate: gate.id,
          expected: expectation.expect,
          observed: gate.status,
          trackedBy: expectation.trackedBy,
        });
      }
    }
  }
  return { counts, unmet };
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

/**
 * A promoted capture must describe one clean, unchanged source snapshot.
 * Check immediately before capture and again immediately before promotion;
 * the manifest may retain that capture commit as provenance without requiring
 * a later commit containing the baseline to have the same, impossible hash.
 */
export function validatePromotionSourceStability(before, after) {
  const errors = [];
  if (before?.sourceDirty !== false) {
    errors.push("PROMOTION_SOURCE_DIRTY_BEFORE_CAPTURE");
  }
  if (after?.sourceDirty !== false) {
    errors.push("PROMOTION_SOURCE_DIRTY_AFTER_CAPTURE");
  }
  if (
    typeof before?.sourceCommit !== "string" ||
    before.sourceCommit !== after?.sourceCommit
  ) {
    errors.push("PROMOTION_SOURCE_COMMIT_CHANGED_DURING_CAPTURE");
  }
  return { valid: errors.length === 0, errors };
}
