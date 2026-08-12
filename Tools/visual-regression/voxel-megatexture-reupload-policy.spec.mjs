// Browser-free policy/mutant gate for probe-voxel-megatexture PART 3.
// Run: node --test Tools/visual-regression/voxel-megatexture-reupload-policy.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  VOXEL_MEGATEXTURE_MAX_RETURN_ATTEMPTS,
  assessVoxelMegatextureReuploadEvidence,
  voxelMegatextureResidentSetWasRepublished,
} from "./lib/voxel-megatexture-reupload-gate.mjs";

const probeSource = fs.readFileSync(
  new URL("./probe-voxel-megatexture.mjs", import.meta.url),
  "utf8",
);

function snapshot(resident, evictionCount, generation, requestSerial = 1) {
  return {
    usingRealData: true,
    slotCount: 13,
    l2Dynamic: true,
    l2PoolSize: 4,
    childUploaded: 8,
    resident: [...resident],
    slotsUsed: [9, 10, 11, 12],
    requestSerials: Array(4).fill(requestSerial),
    slotGenerations: Array(4).fill(generation),
    evictionCount,
    demandCount: 11,
    demandLevel: 2,
    lastTargetLevel: 2,
    maxResident: 4,
  };
}

function validEvidence() {
  const firstA = snapshot([31, 42, 43, 46], 0, 1);
  const firstB = snapshot([0, 1, 2, 4], 4, 2);
  const overflowA = snapshot([47, 55, 58, 59], 8, 3);
  const overflowB = snapshot([5, 8, 16, 17], 12, 4);
  const restoredA = snapshot([31, 42, 43, 46], 16, 5, 2);
  return {
    firstA,
    firstB,
    returnAttempts: [
      { a: overflowA, b: overflowB },
      { a: restoredA, b: null },
    ],
    pixelDiff: { nonBlackA: 282440, mismatchPct: 0 },
    consoleErrorCount: 0,
  };
}

function expectRed(mutator, pattern) {
  const evidence = structuredClone(validEvidence());
  mutator(evidence);
  const assessment = assessVoxelMegatextureReuploadEvidence(evidence);
  assert.equal(assessment.pass, false);
  assert.match(assessment.failures.join("; "), pattern);
}

test("the serialized browser predicate is self-contained in a fresh function scope", () => {
  // eslint-disable-next-line no-new-func
  const injected = new Function(
    `return (${voxelMegatextureResidentSetWasRepublished.toString()});`,
  )();
  const evidence = validEvidence();
  assert.equal(injected(evidence.firstA, evidence.returnAttempts[1].a), true);

  // eslint-disable-next-line no-new-func
  const closureMutant = new Function(
    "return function mutant(firstA, candidate) { " +
      "return sameArray(firstA.resident, candidate.resident); };",
  )();
  assert.throws(
    () => closureMutant(evidence.firstA, evidence.returnAttempts[1].a),
    ReferenceError,
  );
});

test("the canonical overflow-wave A/B/A convergence evidence passes", () => {
  assert.deepEqual(assessVoxelMegatextureReuploadEvidence(validEvidence()), {
    pass: true,
    failures: [],
  });
});

test("serial and slot-generation identity mutants are rejected", () => {
  expectRed((evidence) => {
    evidence.returnAttempts[1].a.requestSerials[2] =
      evidence.firstA.requestSerials[2];
  }, /never re-requested and republished/u);
  expectRed((evidence) => {
    evidence.returnAttempts[1].a.slotGenerations[1] =
      evidence.firstA.slotGenerations[1];
  }, /never re-requested and republished/u);
});

test("every alternating leg must replace four disjoint residents", () => {
  expectRed((evidence) => {
    evidence.returnAttempts[0].a.resident[0] = evidence.firstB.resident[0];
  }, /retained residents from the opposite corner/u);
  expectRed((evidence) => {
    evidence.returnAttempts[0].b.resident[0] =
      evidence.returnAttempts[0].a.resident[0];
  }, /retained residents from corner A/u);
  expectRed((evidence) => {
    evidence.returnAttempts[0].b.evictionCount--;
  }, /did not replace the pool exactly/u);
});

test("missing or overflowing capacity evidence cannot pass", () => {
  expectRed((evidence) => {
    delete evidence.returnAttempts[0].a.maxResident;
  }, /invalid dynamic atlas capacity evidence/u);
  expectRed((evidence) => {
    evidence.returnAttempts[0].a.maxResident = 5;
  }, /invalid dynamic atlas capacity evidence/u);
  expectRed((evidence) => {
    evidence.returnAttempts[0].a.l2PoolSize = 5;
  }, /invalid dynamic atlas capacity evidence/u);
  expectRed((evidence) => {
    evidence.returnAttempts[0].a.demandCount = 4;
  }, /does not preserve the over-capacity demand case/u);
  expectRed((evidence) => {
    evidence.returnAttempts[0].a.slotsUsed[3] = 11;
  }, /does not occupy every pool slot exactly once/u);
  expectRed((evidence) => {
    evidence.returnAttempts[0].a.resident[3] =
      evidence.returnAttempts[0].a.resident[2];
  }, /does not contain exactly the capped resident set/u);
});

test("pixel evidence is non-vacuous and the physical error lane stays empty", () => {
  expectRed((evidence) => {
    evidence.pixelDiff.nonBlackA = 0;
  }, /restored A frame is empty/u);
  expectRed((evidence) => {
    evidence.pixelDiff.mismatchPct = 1.5;
  }, /does not reproduce the first A frame/u);
  expectRed((evidence) => {
    evidence.consoleErrorCount = 1;
  }, /reported console or page errors/u);
});

test("the sweep stops at first restoration and fails closed at its bound", () => {
  expectRed((evidence) => {
    evidence.returnAttempts[1].b = snapshot([6, 9, 18, 19], 20, 6);
  }, /did not stop on the first republished A set/u);
  expectRed((evidence) => {
    const extra = { a: snapshot([20, 21, 22, 23], 20, 6), b: null };
    evidence.returnAttempts.push(extra, extra, extra);
  }, /outside its exact bound/u);
  assert.equal(VOXEL_MEGATEXTURE_MAX_RETURN_ATTEMPTS, 4);
});

test("the physical probe wires bounded serialized convergence and exact evidence", () => {
  for (const pattern of [
    /requestSerials\.push\(du\.l2States\?\.\[i\]\?\.requestSerial/u,
    /slotGenerations\.push\(du\.l2States\?\.\[i\]\?\.slotGeneration/u,
    /maxAttempts: VOXEL_MEGATEXTURE_MAX_RETURN_ATTEMPTS/u,
    /attemptIndex < maxAttempts/u,
    /new Function\(`return \(\$\{republishedSource\}\);`\)\(\)/u,
    /if \(wasRepublished\(firstA, a\)\) \{\s*return \{ converged: true, attempts, finalA: a \};/u,
    /assessVoxelMegatextureReuploadEvidence\(\{/u,
  ]) {
    assert.match(probeSource, pattern);
  }
  assert.doesNotMatch(
    probeSource,
    /JSON\.stringify\(evictA2\.resident\) === JSON\.stringify\(evictA1\.resident\)/u,
  );
});
