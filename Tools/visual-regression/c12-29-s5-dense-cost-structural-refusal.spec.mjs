// @purpose Q-96 — regression coverage for the dense-cost probe's structural
// refusal path: the NASA-SVS schema pin that made the probe unreachable by
// construction, and the `report.prerequisites` shape that turned a
// legitimate STRUCTURAL refusal into an uncaught exception with no
// published artifact and an unreleased RUNNING lock.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/c12-29-s5-dense-cost-structural-refusal.spec.mjs
//
// No browser, no dev server. `loadPrerequisites` (part 1 below) only reads
// local fixture files from disk — the exact resolution path
// `runCoordinator` calls before it launches any Edge process. Part 2 drives
// the real `beginC1229S5DenseRun` / `validateC1229S5DenseFinalArtifact` /
// `foldC1229S5DenseCostGate` / `publishC1229S5DenseFinal` functions the
// coordinator itself calls, against a real temp directory.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  C12_29_S5_DENSE_SCHEMA,
  exitCodeForC1229S5DenseStatus,
  foldC1229S5DenseCostGate,
  validateC1229S5DenseFinalArtifact,
  validateC1229S5DensePrerequisites,
} from "./lib/c12-29-s5-dense-cost-gate.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const PUBLICATION_SCHEMA = "cesium-visual-evidence-publication/v2";

/**
 * Writes a fixture publication (manifest + the one JSON artifact it
 * references) shaped exactly the way `resolvePublicationArtifact` in
 * `probe-c12-29-s5-dense-cost.mjs` requires, and returns the manifest path.
 * Byte lengths and hashes are computed from the real bytes written to disk
 * — no field is asserted without also being produced.
 */
async function writeFixturePublication(
  directory,
  { producer, artifactSchema },
) {
  const runId = randomUUID();
  const filesDirectory = path.join(directory, "files");
  await mkdir(filesDirectory, { recursive: true });
  const artifact = {
    schema: artifactSchema,
    runId,
    status: "PASS",
    incomplete: false,
    exitCode: 0,
  };
  const artifactBytes = Buffer.from(JSON.stringify(artifact));
  const artifactPath = path.join(filesDirectory, `${runId}.json`);
  await writeFile(artifactPath, artifactBytes);
  const manifest = {
    schema: PUBLICATION_SCHEMA,
    producer,
    runId,
    result: { status: "PASS", exitCode: 0, certificationEligible: true },
    files: [
      {
        role: "artifact",
        mediaType: "application/json",
        viewPath: `files/${runId}.json`,
        byteLength: artifactBytes.byteLength,
        sha256: sha256(artifactBytes),
      },
    ],
  };
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

test("Q-96a: loadPrerequisites accepts a v5 NASA-SVS publication (the gate's current rung) — no artifact could satisfy the old v4 pin and the gate simultaneously", async () => {
  const { loadPrerequisites } =
    await import("./probe-c12-29-s5-dense-cost.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "c12-29-s5-dense-schema-"));
  try {
    const terrainPublication = await writeFixturePublication(
      path.join(root, "terrain"),
      {
        producer: "c12-29-s5-terrain-selection",
        artifactSchema: "c12-29-s5-terrain-selection-evidence-v10",
      },
    );
    const v5NasaPublication = await writeFixturePublication(
      path.join(root, "nasa-v5"),
      {
        producer: "c12-29-s5-svs-footprint",
        artifactSchema: "c12-29-s5-svs-5073-footprint-evidence-v5",
      },
    );

    // The fix: a v5 artifact — the ONLY schema the gate's
    // C12_29_S5_DENSE_PREREQUISITES.nasa.schema accepts (ruling
    // R-2026-08-14-8) — now resolves AND validates.
    const prerequisites = loadPrerequisites({
      terrainPublication,
      nasaPublication: v5NasaPublication,
    });
    assert.equal(
      prerequisites.nasa.artifact.schema,
      "c12-29-s5-svs-5073-footprint-evidence-v5",
    );
    assert.equal(validateC1229S5DensePrerequisites(prerequisites).valid, true);

    // Mutant check: a v4 artifact — what the OLD probe pin demanded — is
    // rejected by resolvePublicationArtifact's own schema-equality check
    // (probe:398), proving the fix actually changed the accepted schema
    // rather than merely widening it. Before this fix v4 was the ONLY
    // schema `loadPrerequisites` would resolve, yet
    // `validateC1229S5DensePrerequisites` (gate:136) had already moved to
    // v5 — so v4 could pass resolution and still fail validation, and v5
    // could pass validation and never reach it through resolution. No
    // artifact satisfied both.
    const v4NasaPublication = await writeFixturePublication(
      path.join(root, "nasa-v4"),
      {
        producer: "c12-29-s5-svs-footprint",
        artifactSchema: "c12-29-s5-svs-5073-footprint-evidence-v4",
      },
    );
    assert.throws(
      () =>
        loadPrerequisites({
          terrainPublication,
          nasaPublication: v4NasaPublication,
        }),
      /\[structural\] nasa artifact is not the exact final PASS/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Builds the minimal report shape `runCoordinator` produces when it throws
 * before the leg loop runs (a missing/invalid prerequisite, in this
 * repository the only reachable STRUCTURAL cause pre-fix). Every field not
 * under test is set exactly the way `runCoordinator`'s own literal sets it
 * — copied from probe-c12-29-s5-dense-cost.mjs's `lifecycle` object and
 * `report` construction — so the fixture stays faithful to production
 * rather than hand-tuned to pass.
 */
function structuralRefusalReport({ runId, startedAt, prerequisites }) {
  const provenanceSnapshot = {
    ok: false,
    identitySha256: null,
    gitHead: null,
    localFiles: [],
    servedFiles: [],
    buildSourceIdentity: null,
    reasons: ["provenance start absent"],
  };
  return {
    schema: C12_29_S5_DENSE_SCHEMA,
    schemaVersion: 3,
    runId,
    status: "PASS",
    incomplete: false,
    pass: true,
    exitCode: 0,
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
    workload: {
      path: "Tools/visual-regression/performance-workloads-s5-dense-cost.json",
      byteLength: 1,
      sha256: "0".repeat(64),
      value: {},
    },
    prerequisites,
    prerequisitesSha256: null,
    provenance: {
      stable: false,
      start: provenanceSnapshot,
      end: provenanceSnapshot,
    },
    legs: [],
    pendingError: "[structural] nasa publication manifest is required",
    assessment: null,
    lifecycle: {
      lockCreatedExclusively: true,
      runningReceiptCreatedExclusively: true,
      runningLatestPublishedBeforeLaunch: true,
      immutableRunCreatedExclusively: true,
      firstRedPreserved: true,
      firstRedFingerprintPolicy: "write-once-exact-sha256-byte-length",
      finalReceiptCreatedExclusively: true,
      latestEqualsImmutableRunBeforeUnlock: true,
      predecessorAuthorityBoundToRunningReceipt: true,
      publicationAuthorityReverifiedThroughUnlock: true,
      runningReceiptReverifiedThroughUnlock: true,
      lockReleasedByOwnedReceipt: true,
      publicationOrder: [
        "lock",
        "running-receipt",
        "running-latest",
        "immutable-run",
        "first-red",
        "final-latest",
        "final-receipt",
        "unlock",
      ],
    },
  };
}

/** Folds status/exitCode/pass onto `report` exactly as runCoordinator does
 * (fold, stamp, fold again — the second fold is what makes
 * `lifecycle.firstRedPreserved` consistent with the final status). */
function foldReport(report) {
  let assessment = foldC1229S5DenseCostGate(report);
  report.status = assessment.status;
  report.exitCode = assessment.exitCode;
  report.pass = assessment.pass;
  report.lifecycle.firstRedPreserved = report.status !== "PASS";
  assessment = foldC1229S5DenseCostGate(report);
  report.status = assessment.status;
  report.exitCode = assessment.exitCode;
  report.pass = assessment.pass;
  report.assessment = assessment;
  return report;
}

test("Q-96b: fold already derives STRUCTURAL/exit 3 for a missing-prerequisites report — the bug is entirely in the final-artifact shape gate", () => {
  const report = foldReport(
    structuralRefusalReport({
      runId: randomUUID(),
      startedAt: new Date().toISOString(),
      prerequisites: null,
    }),
  );
  assert.equal(report.status, "STRUCTURAL");
  assert.equal(report.exitCode, exitCodeForC1229S5DenseStatus("STRUCTURAL"));
  assert.equal(report.pass, false);
});

test("Q-96b: prerequisites:null (the pre-fix shape) is rejected by validateC1229S5DenseFinalArtifact — reproduces the uncaught-throw bug", () => {
  const report = foldReport(
    structuralRefusalReport({
      runId: randomUUID(),
      startedAt: new Date().toISOString(),
      prerequisites: null,
    }),
  );
  const validation = validateC1229S5DenseFinalArtifact(report);
  assert.equal(validation.valid, false);
  assert.ok(
    validation.reasons.includes("campaign envelope differs"),
    `expected "campaign envelope differs" among ${JSON.stringify(validation.reasons)}`,
  );
});

test("Q-96b: prerequisites:{terrain:null,nasa:null} (the fix) passes validateC1229S5DenseFinalArtifact and publishes + releases the lock", async () => {
  const {
    beginC1229S5DenseRun,
    createC1229S5DenseArtifactPaths,
    publishC1229S5DenseFinal,
  } = await import("./probe-c12-29-s5-dense-cost.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "c12-29-s5-dense-refusal-"));
  try {
    const runId = randomUUID();
    const paths = createC1229S5DenseArtifactPaths(root, runId);
    const { running, publicationAuthority } = beginC1229S5DenseRun(
      paths,
      runId,
    );
    // The lock is genuinely acquired on disk — the same call runCoordinator
    // makes before anything fallible runs.
    assert.equal(fs.existsSync(paths.lock), true);

    const report = foldReport(
      structuralRefusalReport({
        runId,
        startedAt: running.startedAt,
        // The fix under test: a two-key object, not `null`.
        prerequisites: { terrain: null, nasa: null },
      }),
    );

    const validation = validateC1229S5DenseFinalArtifact(report);
    assert.equal(
      validation.valid,
      true,
      `expected valid; reasons: ${JSON.stringify(validation.reasons)}`,
    );
    assert.equal(report.status, "STRUCTURAL");
    assert.equal(report.exitCode, 3);

    // publishC1229S5DenseFinal is the exact function runCoordinator calls
    // next. It must succeed (write the immutable artifact) and release the
    // owned RUNNING lock — proving Q-96's "no verdict artifact, stranded
    // RUNNING lock" symptom is gone for this report shape.
    publishC1229S5DenseFinal(paths, publicationAuthority, report);

    assert.equal(fs.existsSync(paths.immutable), true);
    const published = JSON.parse(fs.readFileSync(paths.immutable, "utf8"));
    assert.equal(published.status, "STRUCTURAL");
    assert.equal(published.runId, runId);

    // The RUNNING lock is gone. releaseC1229S5DenseOwnedLock is the only
    // code path that removes it (rename to a linearization receipt, verify
    // ownership, delete the receipt) — this is Q-96's "stranded RUNNING
    // lock" symptom, closed for this report shape.
    assert.equal(fs.existsSync(paths.lock), false);
    // A STRUCTURAL/non-PASS report also binds the write-once first-red
    // artifact (lifecycle.publicationOrder's "first-red" step).
    assert.equal(fs.existsSync(paths.firstRed), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Mutation proof (CLAUDE.md Principle 10): the gate's shape check
// (`campaignShapeReasons`'s `isObject(report.prerequisites)`, lib:2149)
// requires a plain, non-array, non-null object — nothing weaker. Confirm
// the discrimination is real by sweeping every falsy/non-plain-object value
// `prerequisites` could still be left at if the `??` fallback in
// probe-c12-29-s5-dense-cost.mjs were dropped, aimed wrong, or short-
// circuited by a falsy-but-not-nullish value: every one must still be
// rejected. (`{}` and other well-formed plain objects are legitimately
// ACCEPTED by this same shape gate — that half is proven by the
// `{terrain:null,nasa:null}` case above, which the semantic prerequisite
// validator then separately, correctly flags as incomplete.)
// `undefined` is deliberately excluded from this sweep: `stableC1229S5DenseJson`
// (`JSON.stringify`) returns `undefined` for it, which crashes the gate's own
// `sha256(...)` digest check with an unrelated TypeError before the shape
// check is ever reached — a real, separate, pre-existing gate-lib gap
// (JSON.stringify(undefined) is not serializable) that is out of scope here.
// It is moot for this fix regardless: `prerequisites ?? {...}` in
// probe-c12-29-s5-dense-cost.mjs normalizes `undefined` exactly like `null`,
// so production code never hands the gate a bare `undefined`.
test("mutant check: array/scalar prerequisites values are all still rejected by the shape gate", () => {
  for (const mutant of [[], "absent", 0, false, "null"]) {
    const report = foldReport(
      structuralRefusalReport({
        runId: randomUUID(),
        startedAt: new Date().toISOString(),
        prerequisites: mutant,
      }),
    );
    const validation = validateC1229S5DenseFinalArtifact(report);
    assert.equal(
      validation.valid,
      false,
      `expected prerequisites=${JSON.stringify(mutant)} to be rejected`,
    );
  }
});
