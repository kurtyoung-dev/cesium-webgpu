import assert from "node:assert/strict";
import test from "node:test";
import {
  GateStatus,
  compareCaptures,
  createSceneIdentity,
  evaluatePixelGate,
  resolveSceneThresholds,
  summarizeSceneGates,
  validateManifestEntry,
  validatePromotionRequest,
} from "./lib/visual-gate-policy.mjs";

function capture(red = 0, width = 1, height = 1) {
  return { width, height, data: [red, 0, 0, 255] };
}

function validEntry(overrides = {}) {
  return {
    scene: "scene",
    image: "scene.webgpu.png",
    imageSha256: "a".repeat(64),
    renderer: "webgpu",
    provenanceClass: "accepted-current",
    sourceCommit: "b".repeat(40),
    sourceDirty: false,
    width: 1,
    height: 1,
    sceneIdentity: "c".repeat(64),
    browserClass: "msedge",
    browserVersion: "123.0",
    adapterClass: "vendor:architecture",
    capturedAt: "2026-07-13T00:00:00.000Z",
    review: {
      status: "approved",
      reviewedBy: "reviewer",
      rationale: "Inspected before and after captures.",
      reviewedAt: "2026-07-13T00:00:00.000Z",
    },
    ...overrides,
  };
}

const actual = {
  scene: "scene",
  image: "scene.webgpu.png",
  imageSha256: "a".repeat(64),
  renderer: "webgpu",
  width: 1,
  height: 1,
  sceneIdentity: "c".repeat(64),
  browserClass: "msedge",
  adapterClass: "vendor:architecture",
};

test("scene thresholds independently override the migration fallback", () => {
  assert.deepEqual(
    resolveSceneThresholds(
      {
        thresholds: {
          historicalWebgl: 0.01,
          historicalWebgpu: 0.02,
          crossBackend: 0.03,
        },
      },
      0.5,
    ),
    {
      historicalWebgl: 0.01,
      historicalWebgpu: 0.02,
      crossBackend: 0.03,
    },
  );
});

test("scene identity is stable across object key order", () => {
  const config = {
    baseUrl: "http://example.test",
    settleFrames: 30,
    viewport: { width: 1, height: 1 },
  };
  const a = createSceneIdentity(
    { name: "scene", camera: { x: 1, y: 2 } },
    config,
  );
  const b = createSceneIdentity(
    { camera: { y: 2, x: 1 }, name: "scene" },
    config,
  );
  assert.equal(a, b);
});

test("pixel comparison reports a deterministic mismatch ratio", () => {
  assert.equal(compareCaptures(capture(0), capture(17)).ratio, 1);
  assert.equal(compareCaptures(capture(0), capture(16)).ratio, 0);
  assert.throws(
    () => compareCaptures(capture(0), capture(0, 2, 1)),
    /Dimension mismatch/,
  );
});

test("a missing historical baseline is explicitly non-certifying", () => {
  const result = evaluatePixelGate({
    id: "historicalWebgpu",
    current: capture(),
    reference: null,
    threshold: 0.02,
    manifestValidation: { certifying: false, reasons: [] },
  });
  assert.equal(result.gate.status, GateStatus.NON_CERTIFYING);
  assert.equal(result.gate.comparisonStatus, "NOT_RUN");
  assert.equal(result.gate.historicalAvailable, false);
  assert.equal(result.gate.historicalCertifying, false);
});

test("an unreviewed historical PNG is compared but cannot certify", () => {
  const result = evaluatePixelGate({
    id: "historicalWebgpu",
    current: capture(0),
    reference: capture(255),
    threshold: 0.02,
    manifestValidation: {
      certifying: false,
      reasons: ["MANIFEST_ENTRY_MISSING"],
    },
  });
  assert.equal(result.gate.status, GateStatus.NON_CERTIFYING);
  assert.equal(result.gate.comparisonStatus, GateStatus.FAIL);
  assert.equal(result.gate.historicalAvailable, true);
  assert.equal(result.gate.historicalCertifying, false);
  assert.equal(result.gate.ratio, 1);
});

test("a reviewed historical baseline can pass or fail its own gate", () => {
  const passing = evaluatePixelGate({
    id: "historicalWebgpu",
    current: capture(),
    reference: capture(),
    threshold: 0.02,
    manifestValidation: { certifying: true, reasons: [] },
  });
  const failing = evaluatePixelGate({
    id: "historicalWebgpu",
    current: capture(),
    reference: capture(255),
    threshold: 0.02,
    manifestValidation: { certifying: true, reasons: [] },
  });
  assert.equal(passing.gate.status, GateStatus.PASS);
  assert.equal(failing.gate.status, GateStatus.FAIL);
});

test("cross-backend parity remains independent of historical provenance", () => {
  const result = evaluatePixelGate({
    id: "crossBackend",
    current: capture(),
    reference: capture(),
    threshold: 0.02,
  });
  assert.equal(result.gate.status, GateStatus.PASS);
  assert.equal(result.gate.historicalAvailable, undefined);
});

test("scene summary distinguishes failure from non-certification", () => {
  const pass = { status: GateStatus.PASS };
  const nonCertifying = { status: GateStatus.NON_CERTIFYING };
  const fail = { status: GateStatus.FAIL };
  assert.equal(
    summarizeSceneGates({ a: pass, b: nonCertifying }).status,
    GateStatus.NON_CERTIFYING,
  );
  assert.equal(
    summarizeSceneGates({ a: nonCertifying, b: fail }).status,
    GateStatus.FAIL,
  );
});

test("manifest entries must be reviewed and match the captured environment", () => {
  assert.deepEqual(validateManifestEntry(validEntry(), actual), {
    certifying: true,
    reasons: [],
  });
  const mismatch = validateManifestEntry(
    validEntry({ adapterClass: "different" }),
    actual,
  );
  assert.equal(mismatch.certifying, false);
  assert.ok(mismatch.reasons.includes("MANIFEST_MISMATCH:adapterClass"));

  const dirty = validateManifestEntry(validEntry({ sourceDirty: true }), actual);
  assert.equal(dirty.certifying, false);
  assert.ok(dirty.reasons.includes("MANIFEST_SOURCE_DIRTY"));

  const characterization = validateManifestEntry(
    validEntry({ provenanceClass: "characterization" }),
    actual,
  );
  assert.equal(characterization.certifying, false);
  assert.ok(
    characterization.reasons.includes(
      "MANIFEST_PROVENANCE_NOT_ACCEPTED_CURRENT",
    ),
  );
});

test("--update alone cannot authorize baseline promotion", () => {
  const denied = validatePromotionRequest({ update: true });
  assert.equal(denied.authorized, false);
  assert.equal(denied.errors.length, 3);

  const authorized = validatePromotionRequest({
    update: true,
    confirmBaselinePromotion: true,
    updateRationale: "Reviewed the intended rendering change.",
    reviewedBy: "reviewer",
  });
  assert.equal(authorized.authorized, true);
});
