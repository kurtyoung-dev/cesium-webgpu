import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ExpectationOutcome,
  GateExpectation,
  GateStatus,
  annotateGateExpectation,
  compareCaptures,
  createSceneIdentity,
  evaluatePixelGate,
  resolveSceneExpectations,
  resolveSceneThresholds,
  summarizeExpectations,
  summarizeSceneGates,
  validateManifestEntry,
  validatePromotionRequest,
} from "./lib/visual-gate-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

  const dirty = validateManifestEntry(
    validEntry({ sourceDirty: true }),
    actual,
  );
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

test("a scene without expectations declares none, and malformed ones are rejected", () => {
  assert.deepEqual(resolveSceneExpectations({ name: "plain" }), {
    byGate: {},
    errors: [],
  });

  const cases = [
    [{ expectedMismatch: {} }, "EXPECTATION_NOT_ARRAY:s"],
    [{ expectedMismatch: [null] }, "EXPECTATION_ENTRY_INVALID:s[0]"],
    [
      { expectedMismatch: [{ gate: "nope", expect: "PASS", rationale: "r" }] },
      "EXPECTATION_GATE_UNKNOWN:s[0]:nope",
    ],
    [
      {
        expectedMismatch: [
          { gate: "crossBackend", expect: "MAYBE", rationale: "r" },
        ],
      },
      "EXPECTATION_VALUE_UNKNOWN:s[0]:MAYBE",
    ],
    [
      {
        expectedMismatch: [
          { gate: "crossBackend", expect: "PASS", rationale: "   " },
        ],
      },
      "EXPECTATION_RATIONALE_MISSING:s[0]",
    ],
    [
      {
        expectedMismatch: [
          { gate: "crossBackend", expect: "PASS", rationale: "r" },
          {
            gate: "crossBackend",
            expect: "FAIL",
            rationale: "r",
            trackedBy: "X",
          },
        ],
      },
      "EXPECTATION_GATE_DUPLICATED:s[1]:crossBackend",
    ],
  ];
  for (const [scene, expected] of cases) {
    const resolved = resolveSceneExpectations({ name: "s", ...scene });
    assert.ok(
      resolved.errors.includes(expected),
      `expected ${expected}, got ${JSON.stringify(resolved.errors)}`,
    );
  }
});

test("a predicted FAIL must name a tracker; a predicted PASS need not", () => {
  // This is the rule that keeps `expectedMismatch` from becoming a quieter
  // form of threshold-widening: "expected to fail" with no filed row behind
  // it is exactly the silent normalization the field exists to prevent.
  const untracked = resolveSceneExpectations({
    name: "s",
    expectedMismatch: [
      { gate: "crossBackend", expect: "FAIL", rationale: "known bad" },
    ],
  });
  assert.deepEqual(untracked.errors, ["EXPECTATION_TRACKER_MISSING:s[0]"]);
  assert.deepEqual(untracked.byGate, {});

  const tracked = resolveSceneExpectations({
    name: "s",
    expectedMismatch: [
      {
        gate: "crossBackend",
        expect: "FAIL",
        rationale: "known bad",
        trackedBy: "SOME-FILED-ROW",
      },
      { gate: "historicalWebgl", expect: "PASS", rationale: "stable" },
    ],
  });
  assert.deepEqual(tracked.errors, []);
  assert.equal(tracked.byGate.crossBackend.trackedBy, "SOME-FILED-ROW");
  assert.equal(tracked.byGate.historicalWebgl.trackedBy, null);
});

test("an expectation annotates a gate and changes nothing about its verdict", () => {
  const failing = {
    id: "crossBackend",
    status: GateStatus.FAIL,
    certifying: false,
    ratio: 0.4,
    threshold: 0.02,
  };
  const expected = annotateGateExpectation(failing, {
    gate: "crossBackend",
    expect: GateExpectation.FAIL,
    trackedBy: "SOME-FILED-ROW",
    rationale: "known bad",
  });
  assert.equal(expected.expectation.outcome, ExpectationOutcome.MET);
  // The whole mechanism rests on this: a red scene stays red, and the run's
  // exit code is untouched by anything the manifest claims about it.
  assert.equal(expected.status, GateStatus.FAIL);
  assert.equal(expected.certifying, false);

  const contradicted = annotateGateExpectation(failing, {
    gate: "crossBackend",
    expect: GateExpectation.PASS,
    trackedBy: null,
    rationale: "should be clean",
  });
  assert.equal(contradicted.expectation.outcome, ExpectationOutcome.UNMET);

  // A defect fixed without the record being updated is equally a finding.
  const fixed = annotateGateExpectation(
    { ...failing, status: GateStatus.PASS, certifying: true },
    {
      gate: "crossBackend",
      expect: GateExpectation.FAIL,
      trackedBy: "SOME-FILED-ROW",
      rationale: "known bad",
    },
  );
  assert.equal(fixed.expectation.outcome, ExpectationOutcome.UNMET);

  const unmeasured = annotateGateExpectation(failing, {
    gate: "crossBackend",
    expect: GateExpectation.UNMEASURED,
    trackedBy: null,
    rationale: "never measured in this metric",
  });
  assert.equal(unmeasured.expectation.outcome, ExpectationOutcome.FIRST_RECORD);
  assert.equal(annotateGateExpectation(failing, undefined).expectation, null);
});

test("the run summary counts expectation outcomes and names the unmet ones", () => {
  const summary = summarizeExpectations([
    {
      name: "known-red",
      gates: {
        crossBackend: {
          id: "crossBackend",
          status: GateStatus.FAIL,
          expectation: {
            expect: GateExpectation.FAIL,
            trackedBy: "ROW-A",
            outcome: ExpectationOutcome.MET,
          },
        },
        historicalWebgl: { id: "historicalWebgl", status: GateStatus.PASS },
      },
    },
    {
      name: "new-red",
      gates: {
        crossBackend: {
          id: "crossBackend",
          status: GateStatus.FAIL,
          expectation: {
            expect: GateExpectation.PASS,
            trackedBy: null,
            outcome: ExpectationOutcome.UNMET,
          },
        },
      },
    },
  ]);
  assert.equal(summary.counts.declared, 2);
  assert.equal(summary.counts.MET, 1);
  assert.equal(summary.counts.UNMET, 1);
  assert.deepEqual(summary.unmet, [
    {
      scene: "new-red",
      gate: "crossBackend",
      expected: GateExpectation.PASS,
      observed: GateStatus.FAIL,
      trackedBy: null,
    },
  ]);
});

test("every shipped scene's expectations are valid and its identity is unique", () => {
  // The shipped manifest is the thing the runner actually reads; a fixture
  // that validates while `scenes.json` does not would certify nothing.
  const config = JSON.parse(
    readFileSync(path.join(HERE, "scenes.json"), "utf8"),
  );
  const identities = new Map();
  for (const scene of config.scenes) {
    const resolved = resolveSceneExpectations(scene);
    assert.deepEqual(
      resolved.errors,
      [],
      `${scene.name}: ${resolved.errors.join(", ")}`,
    );
    const identity = createSceneIdentity(scene, {
      baseUrl: config.baseUrl,
      settleFrames: config.settleFrames,
      viewport: { width: 1600, height: 800 },
    });
    assert.equal(
      identities.has(identity),
      false,
      `${scene.name} shares a scene identity with ${identities.get(identity)}`,
    );
    identities.set(identity, scene.name);
  }
});

test("the three subsystem scenes are self-sufficient and deterministic", () => {
  const config = JSON.parse(
    readFileSync(path.join(HERE, "scenes.json"), "utf8"),
  );
  const setupSource = readFileSync(
    path.join(HERE, "scenes", "subsystem-parity-setup.js"),
    "utf8",
  );
  const subsystemScenes = config.scenes.filter(
    (scene) => scene.setupFile === "scenes/subsystem-parity-setup.js",
  );
  assert.deepEqual(
    subsystemScenes.map((scene) => scene.setupParams.subsystem).sort(),
    ["gsplat", "pointcloud", "voxel"],
  );

  for (const scene of subsystemScenes) {
    // Determinism: a pinned clock, and no lon/lat camera in the manifest —
    // all three poses are ECEF and are written to BOTH viewers by the setup.
    assert.match(scene.setupParams.pinnedTimeIso, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(scene.camera, null);
    // Every scene must say what it expects of the cross-backend gate. A new
    // scene that silently omits this is how an unexplained red gets normalized.
    const resolved = resolveSceneExpectations(scene);
    assert.ok(
      resolved.byGate.crossBackend,
      `${scene.name} declares no crossBackend expectation`,
    );
  }

  // Offline: the scenes fetch in-repo paths and nothing else. An absolute URL
  // or an ion asset id would make the suite's result depend on the network,
  // which is the failure mode this assertion exists to catch early — long
  // before a run in an offline lane returns three blank canvases.
  assert.doesNotMatch(
    setupSource,
    /https?:\/\//,
    "the subsystem setup must not reference a network origin",
  );
  assert.doesNotMatch(
    setupSource,
    /ionAssetId|IonResource|createWorldTerrain|fromWorldImagery/,
    "the subsystem setup must not depend on Cesium ion",
  );
  assert.match(setupSource, /"\/Apps\/SampleData\/|\/Apps\/SampleData\//);
  assert.match(setupSource, /"\/Specs\/Data\/Cesium3DTiles\/GaussianSplats\//);

  // Every asset the setup names must exist in this checkout.
  const repositoryRoot = path.resolve(HERE, "../..");
  for (const asset of [
    "Apps/SampleData/Cesium3DTiles/PointCloud/PointCloudTimeDynamic/0.pnts",
    "Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/tileset.json",
  ]) {
    assert.ok(
      existsSync(path.join(repositoryRoot, asset)),
      `${asset} is missing; the scene would capture an empty canvas`,
    );
  }
});

test("no subsystem scene waits on a readiness flag one backend never sets", () => {
  const setupSource = readFileSync(
    path.join(HERE, "scenes", "subsystem-parity-setup.js"),
    "utf8",
  );

  // `VoxelPrimitive.ready` is permanently false on WebGPU: `update` dispatches
  // to the VOXEL_PRIMITIVE feature renderer and returns before the
  // `frameState.afterRender` hook that only the legacy branch runs, and nothing
  // under Renderer/WebGPU sets the flag. Waiting on it across both viewers can
  // never hold, and the first run of `voxel-box-procedural` burned its whole
  // 45 s budget proving it. The budget did its job; the signal was the bug.
  //
  // This is a structural anchor, not a style rule: a readiness predicate that
  // one backend cannot satisfy turns an honest throw into a permanent red, and
  // the next person to reach for `.ready` here gets caught at `node --test`
  // instead of 45 seconds into a browser run.
  assert.doesNotMatch(
    setupSource,
    /\.ready === true/,
    "subsystem setup must not gate readiness on `.ready`, which VoxelPrimitive never sets on WebGPU",
  );

  // The replacement must still be REAL evidence on both backends: a root tile
  // served through this file's own provider (both traversals go through
  // `provider.requestData`) plus frames rendered after that delivery.
  assert.match(
    setupSource,
    /onTileDelivered\(\)/,
    "the voxel scene must count root-tile deliveries as its backend-neutral readiness signal",
  );
  assert.match(
    setupSource,
    /VOXEL_FRAMES_AFTER_DATA/,
    "tile delivery alone does not prove the data reached the GPU; post-delivery frames must be required",
  );
  // And the budget must still THROW — an empty frame on both backends is a
  // cross-backend PASS, so a scene that gives up quietly certifies nothing.
  assert.match(setupSource, /function requireReady\(/);
  assert.match(setupSource, /throw new Error\(/);
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
