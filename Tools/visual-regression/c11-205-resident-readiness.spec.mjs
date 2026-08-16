/**
 * C11-205 — pure-Node contracts for the resident 3D Tiles residency
 * precondition and for the PASS / FAIL / STRUCTURAL classification that the
 * lifecycle probe and the performance campaign both exit on.
 * @purpose Pure-Node contracts for the resident 3D-Tiles residency precondition and the PASS/FAIL/STRUCTURAL exit classification shared by probe and campaign.
 * @status ACTIVE
 *
 * Every gate below is stated as a mutation: the healthy shape passes, and each
 * single-field corruption of it must be refused. A contract that only ever
 * sees its healthy input proves nothing about the day the input is wrong.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createRepresentativeTilesetResidencyAccumulator,
  isRepresentativeResidentRoutePassQuiescent,
  sampleRepresentativeTilesetResidency,
  summarizeRepresentativeTilesetResidency,
} from "./lib/representative-performance-content.mjs";
import {
  C11_205_MULTIPLE_CONTENT_FIXTURE,
  C11_205_PACKET_MUTATIONS,
  classifyCrossLegGates,
  classifyLifecycleLegGates,
  classifyPerformanceCampaignExit,
  classifyStatePacketMutationGates,
  combineC11205Gates,
  formatC11205Gates,
} from "./lib/c11-205-evidence.mjs";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(toolDirectory, "..", "..");
const runnerSource = readFileSync(
  resolve(toolDirectory, "run-performance-campaign.mjs"),
  "utf8",
);
const probeSource = readFileSync(
  resolve(toolDirectory, "probe-c11-205-lifecycle-v2.mjs"),
  "utf8",
);

function makeTileset(overrides = {}) {
  return {
    tilesLoaded: true,
    statistics: {
      numberOfPendingRequests: 0,
      numberOfTilesProcessing: 0,
      numberOfAttemptedRequests: 0,
      numberOfLoadedTilesTotal: 12,
      geometryByteLength: 1000,
      texturesByteLength: 500,
      batchTableByteLength: 100,
      ...overrides.statistics,
    },
    ...overrides,
  };
}

function quiescentResidency(overrides = {}) {
  return {
    schemaVersion: 1,
    tilesetCount: 4,
    frames: 600,
    notLoadedFrames: 0,
    pendingRequestFrames: 0,
    processingFrames: 0,
    attemptedRequestFrames: 0,
    loadedTilesTotalDelta: 0,
    contentByteLengthDelta: 0,
    ...overrides,
  };
}

// ── the fixture premise ─────────────────────────────────────────────────────

test("the real multiple-content fixture exists and declares two content slots", () => {
  const fixturePath = resolve(
    repositoryDirectory,
    C11_205_MULTIPLE_CONTENT_FIXTURE.repositoryPath,
  );
  const tileset = JSON.parse(readFileSync(fixturePath, "utf8"));
  assert.equal(
    tileset.asset.version,
    C11_205_MULTIPLE_CONTENT_FIXTURE.assetVersion,
  );
  assert.equal(
    tileset.root.contents.length,
    C11_205_MULTIPLE_CONTENT_FIXTURE.contentSlots,
  );
  assert.deepEqual(
    tileset.root.contents.map((content) => content.uri),
    [...C11_205_MULTIPLE_CONTENT_FIXTURE.contentUris],
  );
  // Every declared payload must actually be on disk, otherwise the "real
  // fixture" claim is a 404 waiting to be scored as a product failure.
  for (const uri of C11_205_MULTIPLE_CONTENT_FIXTURE.contentUris) {
    const payload = resolve(dirname(fixturePath), uri);
    assert.ok(readFileSync(payload).byteLength > 0, `${uri} is empty`);
  }
});

test("the probe drives the real fixture rather than a synthesized tileset", () => {
  assert.match(probeSource, /C11_205_MULTIPLE_CONTENT_FIXTURE/);
  // The header documents the fixture in prose; the executable path must come
  // from the shared constant so the probe and the spec cannot drift apart.
  const executablePathLiterals = probeSource
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .filter((line) => line.includes("Specs/Data/Cesium3DTiles"));
  assert.deepEqual(executablePathLiterals, []);
});

// ── residency sampling ──────────────────────────────────────────────────────

test("a residency sample sums every tracked tileset", () => {
  const sample = sampleRepresentativeTilesetResidency([
    makeTileset(),
    makeTileset(),
  ]);
  assert.equal(sample.tilesetCount, 2);
  assert.equal(sample.allTilesLoaded, true);
  assert.equal(sample.loadedTilesTotal, 24);
  assert.equal(sample.contentByteLength, 3200);
});

test("a residency sample refuses to call an unmeasurable tileset resident", () => {
  for (const broken of [
    [],
    [makeTileset({ tilesLoaded: false })],
    [makeTileset({ statistics: undefined }), makeTileset()],
    [makeTileset(), null],
  ]) {
    const sample = sampleRepresentativeTilesetResidency(broken);
    assert.equal(sample.allTilesLoaded, false);
  }
  // A tileset with no statistics contributes no counts it cannot state.
  const partial = sampleRepresentativeTilesetResidency([
    { tilesLoaded: true, statistics: undefined },
  ]);
  assert.equal(partial.loadedTilesTotal, 0);
});

test("the residency accumulator reads deltas against its first observation", () => {
  const tilesets = [makeTileset()];
  const accumulator = createRepresentativeTilesetResidencyAccumulator(tilesets);
  accumulator.observe();
  tilesets[0].statistics.numberOfPendingRequests = 2;
  accumulator.observe();
  tilesets[0].statistics.numberOfPendingRequests = 0;
  tilesets[0].statistics.numberOfLoadedTilesTotal = 15;
  tilesets[0].statistics.geometryByteLength = 4000;
  tilesets[0].tilesLoaded = false;
  accumulator.observe();

  const summary = accumulator.summarize();
  assert.equal(summary.frames, 3);
  assert.equal(summary.notLoadedFrames, 1);
  assert.equal(summary.pendingRequestFrames, 1);
  assert.equal(summary.loadedTilesTotalDelta, 3);
  assert.equal(summary.contentByteLengthDelta, 3000);
  assert.equal(
    summarizeRepresentativeTilesetResidency(summary).quiescent,
    false,
  );
});

test("an accumulator that never observed a frame is not quiescent", () => {
  const summary = createRepresentativeTilesetResidencyAccumulator([
    makeTileset(),
  ]).summarize();
  assert.equal(summary.frames, 0);
  assert.equal(summary.loadedTilesTotalDelta, null);
  assert.equal(
    summarizeRepresentativeTilesetResidency(summary).quiescent,
    false,
  );
});

test("residency quiescence fails closed on every corrupted field", () => {
  assert.equal(
    summarizeRepresentativeTilesetResidency(quiescentResidency()).quiescent,
    true,
  );
  const mutations = [
    undefined,
    null,
    "resident",
    quiescentResidency({ frames: 0 }),
    quiescentResidency({ frames: undefined }),
    quiescentResidency({ tilesetCount: 0 }),
    quiescentResidency({ notLoadedFrames: 1 }),
    quiescentResidency({ notLoadedFrames: undefined }),
    quiescentResidency({ pendingRequestFrames: 3 }),
    quiescentResidency({ processingFrames: 1 }),
    quiescentResidency({ attemptedRequestFrames: 1 }),
    quiescentResidency({ loadedTilesTotalDelta: 1 }),
    quiescentResidency({ loadedTilesTotalDelta: -1 }),
    quiescentResidency({ loadedTilesTotalDelta: null }),
    quiescentResidency({ contentByteLengthDelta: -4096 }),
    quiescentResidency({ contentByteLengthDelta: null }),
  ];
  for (const mutation of mutations) {
    const summary = summarizeRepresentativeTilesetResidency(mutation);
    assert.equal(
      summary.quiescent,
      false,
      `expected refusal for ${JSON.stringify(mutation)}`,
    );
    assert.ok(summary.reasons.length > 0);
  }
});

test("a negative resident byte delta names the unload it detected", () => {
  const summary = summarizeRepresentativeTilesetResidency(
    quiescentResidency({ contentByteLengthDelta: -4096 }),
  );
  assert.match(summary.reasons.join(" "), /contentByteLengthDelta=-4096/);
});

test("the resident route pass gate now requires 3D Tiles residency", () => {
  const terrainQuiescent = {
    requestCount: 0,
    tileGenerationCount: 0,
    globeTilesNotLoadedFrames: 0,
  };
  assert.equal(
    isRepresentativeResidentRoutePassQuiescent(terrainQuiescent),
    false,
  );
  assert.equal(
    isRepresentativeResidentRoutePassQuiescent({
      ...terrainQuiescent,
      tilesetResidency: quiescentResidency(),
    }),
    true,
  );
});

// ── campaign wiring ─────────────────────────────────────────────────────────

test("the campaign observes tileset residency in convergence and measurement", () => {
  assert.match(
    runnerSource,
    /createRepresentativeTilesetResidencyAccumulator\(\s*representativeHarness\.assets\.tilesets/,
  );
  assert.match(runnerSource, /convergenceTilesetResidency\.observe\(\)/);
  assert.match(
    runnerSource,
    /tilesetResidency: convergenceTilesetResidency\.summarize\(\)/,
  );
  assert.match(
    runnerSource,
    /measurementTilesetResidencyAccumulator\?\.observe\(\)/,
  );
  assert.match(
    runnerSource,
    /measurementTilesetResidency:\s*\n?\s*measurementTilesetResidencyAccumulator\?\.summarize\(\)/,
  );
  assert.match(runnerSource, /summarizeRepresentativeTilesetResidency\(/);
  // A failed residency precondition is an instrument gap, so it must be
  // recorded as structural rather than as a renderer verdict.
  assert.match(runnerSource, /browserResult\.quality\.structural = true/);
  assert.match(runnerSource, /\[structural\] representative resident route/);
  assert.match(runnerSource, /classifyPerformanceCampaignExit\(report\)/);
  assert.match(
    runnerSource,
    /process\.exitCode = exitClassification\.exitCode/,
  );
  assert.ok(
    !/if \(report\.result !== "pass"\) process\.exitCode = 1;/.test(
      runnerSource,
    ),
    "the campaign must not collapse structural runs into exit 1",
  );
});

// ── lifecycle leg gates ─────────────────────────────────────────────────────

function healthyLeg(overrides = {}) {
  return {
    requestedRenderer: "webgpu",
    stableFramesRequired: 12,
    faults: [],
    reachError: null,
    result: {
      renderer: "webgpu",
      frames: 40,
      stableFrames: 12,
      tilesLoaded: true,
      ledger: {
        valid: true,
        complete: true,
        openRequestCount: 0,
        requestCount: 2,
        signature: "27b1e7d0-dd48cecb",
        coverage: {
          multipleContentSupported: true,
          multipleContentObserved: true,
        },
        readiness: {
          models: [
            { modelReady: true, contentReady: true },
            { modelReady: true, contentReady: true },
          ],
          tiles: [{ tileReady: true }],
        },
      },
      mutation: healthyMutation(),
    },
    ...overrides,
  };
}

function healthyMutation(overrides = {}) {
  return {
    supported: true,
    contentSlots: 2,
    steady: { frames: 30, versionChanges: 0 },
    steps: C11_205_PACKET_MUTATIONS.map((entry) => ({
      property: entry.property,
      value: entry.value,
      versionDelta: 1,
      observedModels: 2,
      mismatchedModels: 0,
    })),
    dynamic: { applied: true, versionDelta: 0 },
    ...overrides,
  };
}

function gateValue(gates, id) {
  return gates.find((entry) => entry.id === id)?.value;
}

test("a healthy leg decides every lifecycle and mutation gate green", () => {
  const leg = healthyLeg();
  const gates = [
    ...classifyLifecycleLegGates(leg),
    ...classifyStatePacketMutationGates(leg),
  ];
  assert.equal(gates.length, 11);
  for (const entry of gates) {
    assert.equal(entry.value, true, `${entry.id} was not green`);
  }
  assert.equal(combineC11205Gates(gates).exitCode, 0);
});

test("an unreachable fixture is STRUCTURAL, never a product FAIL", () => {
  const gates = classifyLifecycleLegGates({
    requestedRenderer: "webgpu",
    stableFramesRequired: 12,
    faults: [],
    reachError: "404 Not Found",
    result: null,
  });
  assert.equal(gateValue(gates, "L1"), null);
  assert.equal(gateValue(gates, "L3"), null);
  const combined = combineC11205Gates(gates);
  assert.equal(combined.failed, false);
  assert.equal(combined.exitCode, 3);
});

test("a leg that resolved the other backend is not the leg under test", () => {
  const leg = healthyLeg();
  leg.result.renderer = "webgl";
  const gates = classifyLifecycleLegGates(leg);
  assert.equal(gateValue(gates, "L2"), null);
  assert.equal(gateValue(gates, "L3"), null);
  assert.equal(combineC11205Gates(gates).exitCode, 3);
});

test("supported-but-unobserved multiple content is a real FAIL", () => {
  const leg = healthyLeg();
  leg.result.ledger.coverage.multipleContentObserved = false;
  const gates = classifyLifecycleLegGates(leg);
  assert.equal(gateValue(gates, "L3"), false);
  assert.equal(combineC11205Gates(gates).exitCode, 1);
});

test("an unsupported schema cannot decide the multiple-content gate", () => {
  const leg = healthyLeg();
  leg.result.ledger.coverage.multipleContentSupported = false;
  const gates = classifyLifecycleLegGates(leg);
  assert.equal(gateValue(gates, "L3"), null);
  assert.equal(gateValue(gates, "L4"), null);
  assert.equal(combineC11205Gates(gates).failed, false);
});

test("each single ledger or readiness defect is refused on its own", () => {
  const mutations = [
    ["L4", (leg) => (leg.result.ledger.valid = false)],
    ["L4", (leg) => (leg.result.ledger.complete = false)],
    ["L4", (leg) => (leg.result.ledger.openRequestCount = 1)],
    ["L5", (leg) => leg.result.ledger.readiness.models.pop()],
    [
      "L5",
      (leg) => (leg.result.ledger.readiness.models[0].contentReady = false),
    ],
    ["L5", (leg) => (leg.result.ledger.readiness.models[1].modelReady = false)],
    ["L5", (leg) => (leg.result.ledger.readiness.tiles.length = 0)],
    ["L6", (leg) => (leg.result.stableFrames = 11)],
    ["L7", (leg) => leg.faults.push("device lost")],
  ];
  for (const [id, mutate] of mutations) {
    const leg = healthyLeg();
    mutate(leg);
    const gates = classifyLifecycleLegGates(leg);
    assert.equal(gateValue(gates, id), false, `${id} should have failed`);
    assert.equal(combineC11205Gates(gates).exitCode, 1);
  }
});

test("missing readiness evidence is structural, not a silent pass", () => {
  const leg = healthyLeg();
  leg.result.ledger.readiness = null;
  const gates = classifyLifecycleLegGates(leg);
  assert.equal(gateValue(gates, "L5"), null);
  assert.equal(combineC11205Gates(gates).failed, false);
  assert.equal(combineC11205Gates(gates).exitCode, 3);
});

// ── state-packet mutation gates ─────────────────────────────────────────────

test("every state-packet mutation defect is refused on its own", () => {
  const mutations = [
    ["M1", healthyMutation({ steady: { frames: 30, versionChanges: 1 } })],
    [
      "M2",
      healthyMutation({
        steps: healthyMutation().steps.map((step, index) =>
          index === 1 ? { ...step, versionDelta: 2 } : step,
        ),
      }),
    ],
    [
      "M2",
      healthyMutation({
        steps: healthyMutation().steps.map((step, index) =>
          index === 0 ? { ...step, versionDelta: 0 } : step,
        ),
      }),
    ],
    ["M2", healthyMutation({ steps: healthyMutation().steps.slice(0, 2) })],
    [
      "M3",
      healthyMutation({
        steps: healthyMutation().steps.map((step, index) =>
          index === 2 ? { ...step, mismatchedModels: 1 } : step,
        ),
      }),
    ],
    [
      "M3",
      healthyMutation({
        steps: healthyMutation().steps.map((step, index) =>
          index === 0 ? { ...step, observedModels: 1 } : step,
        ),
      }),
    ],
    ["M4", healthyMutation({ dynamic: { applied: false, versionDelta: 0 } })],
    ["M4", healthyMutation({ dynamic: { applied: true, versionDelta: 1 } })],
  ];
  for (const [id, mutation] of mutations) {
    const leg = healthyLeg();
    leg.result.mutation = mutation;
    const gates = classifyStatePacketMutationGates(leg);
    assert.equal(gateValue(gates, id), false, `${id} should have failed`);
    assert.equal(combineC11205Gates(gates).exitCode, 1);
  }
});

test("unreachable content slots make the mutation lane structural", () => {
  for (const mutation of [
    undefined,
    null,
    { supported: false, reason: "only 1 model-bearing content slot" },
  ]) {
    const leg = healthyLeg();
    leg.result.mutation = mutation;
    const gates = classifyStatePacketMutationGates(leg);
    assert.equal(gates.length, 4);
    for (const entry of gates) {
      assert.equal(entry.value, null);
    }
    assert.equal(combineC11205Gates(gates).exitCode, 3);
  }
});

test("steady evidence with no observed frames cannot decide churn", () => {
  const leg = healthyLeg();
  leg.result.mutation = healthyMutation({
    steady: { frames: 0, versionChanges: 0 },
  });
  const gates = classifyStatePacketMutationGates(leg);
  assert.equal(gateValue(gates, "M1"), null);
});

// ── cross-leg gate ──────────────────────────────────────────────────────────

test("cross-leg agreement requires two legs that both produced a signature", () => {
  const webgl = healthyLeg({ requestedRenderer: "webgl" });
  webgl.result.renderer = "webgl";
  const webgpu = healthyLeg();
  assert.equal(gateValue(classifyCrossLegGates([webgl, webgpu]), "X1"), true);

  webgpu.result.ledger.signature = "deadbeef-deadbeef";
  assert.equal(gateValue(classifyCrossLegGates([webgl, webgpu]), "X1"), false);

  // One leg alone must never read as agreement.
  assert.equal(gateValue(classifyCrossLegGates([webgl]), "X1"), null);
  assert.equal(gateValue(classifyCrossLegGates([]), "X1"), null);
  const missing = healthyLeg();
  missing.result.ledger.signature = null;
  assert.equal(gateValue(classifyCrossLegGates([webgl, missing]), "X1"), null);
});

test("an empty gate set is structural rather than vacuously green", () => {
  const combined = combineC11205Gates([]);
  assert.equal(combined.exitCode, 3);
  assert.equal(combined.failed, false);
  assert.equal(combineC11205Gates(undefined).exitCode, 3);
});

test("gate formatting names the verdict for every tri-state", () => {
  const lines = formatC11205Gates([
    { id: "A", label: "one", value: true, detail: "d" },
    { id: "B", label: "two", value: false, detail: "" },
    { id: "C", label: "three", value: null, detail: "" },
  ]);
  assert.match(lines[0], /^A one: PASS d$/);
  assert.match(lines[1], /^B two: FAIL$/);
  assert.match(lines[2], /^C three: STRUCTURAL$/);
});

// ── campaign exit classification ────────────────────────────────────────────

function campaignReport(overrides = {}) {
  return {
    result: "pass",
    runs: [
      { renderer: "webgl", workloadId: "w", repetition: 1, result: "pass" },
      { renderer: "webgpu", workloadId: "w", repetition: 1, result: "pass" },
    ],
    representativePairSummaries: {},
    aggregates: {},
    ...overrides,
  };
}

test("a clean campaign exits green", () => {
  const classification = classifyPerformanceCampaignExit(campaignReport());
  assert.equal(classification.exitCode, 0);
  assert.equal(classification.verdict, "PASS");
});

test("a ready-set divergence between clean legs stays a product FAIL", () => {
  const classification = classifyPerformanceCampaignExit(
    campaignReport({
      result: "fail",
      representativePairSummaries: {
        "moving-camera-representative-resident-terrain-assets-3d": {
          reasons: [
            "6/6 pairs held different 3D Tiles ready sets, so no causal renderer timing claim can be made from this workload",
          ],
        },
      },
    }),
  );
  assert.equal(classification.exitCode, 1);
  assert.equal(classification.verdict, "FAIL");
  assert.match(classification.productCauses.join(" "), /ready sets/);
});

test("an unmet residency precondition is STRUCTURAL and absorbs its downstream", () => {
  const report = campaignReport({
    result: "fail",
    runs: [
      {
        renderer: "webgl",
        workloadId: "w",
        repetition: 1,
        result: "fail",
        structural: true,
        failures: ["resident 3D Tiles content was not fully resident"],
      },
      { renderer: "webgpu", workloadId: "w", repetition: 1, result: "pass" },
    ],
    representativePairSummaries: {
      w: { reasons: ["1/1 pairs held different 3D Tiles ready sets"] },
    },
  });
  const classification = classifyPerformanceCampaignExit(report);
  assert.equal(classification.exitCode, 3);
  assert.equal(classification.verdict, "INCOMPLETE (structural)");
  assert.equal(classification.productCauses.length, 0);
  assert.match(
    classification.structuralCauses.join(" "),
    /downstream of an unmet measurement precondition/,
  );
});

test("a product failure alongside a structural one still exits 1", () => {
  const classification = classifyPerformanceCampaignExit(
    campaignReport({
      result: "fail",
      runs: [
        {
          renderer: "webgl",
          workloadId: "w",
          repetition: 1,
          result: "fail",
          structural: true,
          failures: ["precondition"],
        },
        {
          renderer: "webgpu",
          workloadId: "w",
          repetition: 1,
          result: "fail",
          failures: ["index buffer overflow"],
        },
      ],
    }),
  );
  assert.equal(classification.exitCode, 1);
});

test("an invalid-quality run counts even when its result says pass", () => {
  const classification = classifyPerformanceCampaignExit(
    campaignReport({
      result: "fail",
      runs: [
        {
          renderer: "webgpu",
          workloadId: "w",
          repetition: 1,
          result: "pass",
          quality: { status: "invalid" },
          failures: ["quality invalid"],
        },
      ],
    }),
  );
  assert.equal(classification.exitCode, 1);
});

test("an unstable aggregate is a product cause", () => {
  const classification = classifyPerformanceCampaignExit(
    campaignReport({
      result: "fail",
      aggregates: { "webgpu:w": { stable: false } },
    }),
  );
  assert.equal(classification.exitCode, 1);
  assert.match(classification.productCauses.join(" "), /stability/);
});

test("a non-pass campaign with no recorded cause is never rounded to green", () => {
  const classification = classifyPerformanceCampaignExit(
    campaignReport({ result: "fail" }),
  );
  assert.equal(classification.exitCode, 1);
  assert.match(classification.productCauses.join(" "), /no recorded cause/);
});

test("a pass report contradicted by its own runs is refused", () => {
  const classification = classifyPerformanceCampaignExit(
    campaignReport({
      runs: [
        {
          renderer: "webgpu",
          workloadId: "w",
          repetition: 1,
          result: "fail",
          failures: ["boom"],
        },
      ],
    }),
  );
  assert.equal(classification.exitCode, 1);
});

test("a campaign exception is exit 2 and a missing report is exit 1", () => {
  assert.equal(
    classifyPerformanceCampaignExit({ result: "error", errors: ["boom"] })
      .exitCode,
    2,
  );
  assert.equal(classifyPerformanceCampaignExit(null).exitCode, 1);
  assert.equal(classifyPerformanceCampaignExit("nope").exitCode, 1);
});
