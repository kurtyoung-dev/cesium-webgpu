// @purpose Scans the migration_doc finding-source files for NEW-* IDs and enforces each has an ownership disposition (alias/placeholder/resolved).
// @status ACTIVE

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const migrationRoot = path.join(repositoryRoot, "migration_doc");

const findingSourceNames = Object.freeze([
  "WEBGPU_DEBUGGING_LOG.md",
  "PERF_ARCH_DEEP_DIVE_2026-07-16.md",
  "FORK_PERFORMANCE_AUDIT_AND_FIX_RESULTS_2026-07-14.md",
  "VOXEL_POINTCLOUD_GSPLAT_AUDIT_2026-08-09.md",
  "HANDOVER_AUDIT_2026-08-09.md",
]);

const findingPattern = /\bNEW-[A-Z0-9][A-Z0-9-]{2,}[A-Z0-9]\b/g;

const explicitDispositions = Object.freeze({
  "NEW-5-XXX": Object.freeze({ kind: "placeholder" }),
  "NEW-PERF-CAPPED-UNCAPPED-LANES": Object.freeze({
    kind: "alias",
    owners: Object.freeze(["FAR-007-RENDER-PACING-LANES"]),
  }),
  "NEW-PICK-WEBGPU-QUERY-ARCHITECTURE": Object.freeze({
    kind: "alias",
    owners: Object.freeze([
      "FAR-107-PICKQUERY-CONTRACT",
      "FAR-409-GRAPH-OWNED-PICK-MINIFRAME",
    ]),
  }),
  "NEW-WEBGPU-SPLAT-SNAPSHOT-READINESS-GL-PREDICATE": Object.freeze({
    kind: "resolved-in-source",
    source: "WEBGPU_DEBUGGING_LOG.md",
    evidence: Object.freeze(["**Fix:**", "**Guard:**"]),
  }),
  "NEW-WEBGPU-FOG-MS-STALE-EXTINCTION-COPY": Object.freeze({
    kind: "resolved-in-source",
    source: "WEBGPU_DEBUGGING_LOG.md",
    evidence: Object.freeze(["**Fix.**", "mutation"]),
  }),
  "NEW-WEBGPU-CHUNK-SHADOW-RECEIVE-STALE": Object.freeze({
    kind: "resolved-in-source",
    source: "WEBGPU_DEBUGGING_LOG.md",
    evidence: Object.freeze(["**Fix.**", "naga-validates"]),
  }),
});

function readMigrationFile(relativePath) {
  return readFileSync(path.join(migrationRoot, relativePath), "utf8");
}

function walkFilesNamed(directory, fileName) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFilesNamed(entryPath, fileName));
    } else if (entry.isFile() && entry.name === fileName) {
      result.push(entryPath);
    }
  }
  return result;
}

function walkMarkdown(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkMarkdown(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(entryPath);
    }
  }
  return result;
}

function isOwnershipDocument(filePath) {
  const baseName = path.basename(filePath);
  const relativePath = path
    .relative(migrationRoot, filePath)
    .split(path.sep)
    .join("/");
  return (
    baseName === "DEFERRED_WORK.md" ||
    baseName === "FEATURE_INVENTORY.md" ||
    baseName === "FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md" ||
    baseName.startsWith("QUEUE_") ||
    baseName.startsWith("NEXT_QUEUE") ||
    relativePath === "campaign11_planning/CANDIDATE_REGISTER.md"
  );
}

function markdownSectionContaining(source, findingId) {
  const findingOffset = source.indexOf(findingId);
  assert.notEqual(findingOffset, -1, `missing source finding ${findingId}`);
  const headingOffset = source.lastIndexOf("\n## ", findingOffset);
  const sectionStart = headingOffset === -1 ? 0 : headingOffset + 1;
  const nextHeadingOffset = source.indexOf(
    "\n## ",
    findingOffset + findingId.length,
  );
  return source.slice(
    sectionStart,
    nextHeadingOffset === -1 ? source.length : nextHeadingOffset,
  );
}

const findingSources = new Map(
  findingSourceNames.map((name) => [name, readMigrationFile(name)]),
);
const findingIds = new Set(
  [...findingSources.values()].flatMap((source) =>
    Array.from(source.matchAll(findingPattern), (match) => match[0]),
  ),
);
const ownershipFiles = walkMarkdown(migrationRoot).filter(isOwnershipDocument);
const ownershipCorpus = ownershipFiles
  .map((filePath) => readFileSync(filePath, "utf8"))
  .join("\n");
const dispositionLedger = JSON.parse(
  readMigrationFile("FINDING_DISPOSITIONS_2026-08-13.json"),
);
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const rulingIdPattern = /^R-\d{4}-\d{2}-\d{2}-\d+$/;

// Which owner states each disposition may name. Hoisted out of the ledger walk
// because the walk can only exercise the pairs the ledger happens to contain:
// widening this table is invisible there and must be caught here instead.
const ownerStatesByDisposition = Object.freeze({
  "active-repair": Object.freeze(["active"]),
  "closed-by-certifying-pass": Object.freeze(["closed", "reopened"]),
});

// The owner state model. `reopened` exists because a closure can be overturned:
// R-2026-08-17-7 ruled that vacating one means moving the machine-readable state,
// not editing the prose, since consumers read `state` and a stale `closed` keeps
// propagating an overturned status. A reopened owner MUST name the ruling that
// overturned it and MUST retain its `closureRunId` — the run happened, and
// history is not rewritten; only its warrant lapsed.
const ownerStateModel = Object.freeze({
  active: Object.freeze({
    required: Object.freeze(["document", "reference", "state"]),
    optional: Object.freeze([]),
  }),
  closed: Object.freeze({
    required: Object.freeze(["closureRunId", "document", "reference", "state"]),
    optional: Object.freeze([]),
  }),
  reopened: Object.freeze({
    required: Object.freeze([
      "closureRunId",
      "document",
      "reference",
      "reopenedBy",
      "state",
    ]),
    optional: Object.freeze([
      "closureRunAnnotation",
      "priorState",
      "reopenedRecordedBy",
    ]),
  }),
});

// One validator for the real ledger walk AND for the synthetic owners the state
// model test drives, so a branch cannot be exercised by tests while the real
// walk uses different rules.
function assertOwnerShape(ownerId, owner) {
  assert.ok(
    Object.hasOwn(ownerStateModel, owner.state),
    `${ownerId} has unknown state ${String(owner.state)}`,
  );
  const { required, optional } = ownerStateModel[owner.state];
  const keys = Object.keys(owner).sort();
  for (const key of required) {
    assert.ok(keys.includes(key), `${ownerId} is missing ${key}`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of keys) {
    assert.ok(allowed.has(key), `${ownerId} carries undeclared key ${key}`);
  }
  if (owner.state !== "active") {
    assert.match(owner.closureRunId, uuidV4Pattern);
  }
  if (owner.state === "reopened") {
    assert.match(owner.reopenedBy, rulingIdPattern);
    if (Object.hasOwn(owner, "reopenedRecordedBy")) {
      assert.match(owner.reopenedRecordedBy, rulingIdPattern);
    }
    if (Object.hasOwn(owner, "priorState")) {
      assert.equal(owner.priorState, "closed");
    }
  }
}

test("canonical finding sources retain a non-vacuous ownership census", () => {
  assert.ok(
    findingIds.size >= 200,
    `finding census unexpectedly small: ${findingIds.size}`,
  );
  assert.ok(
    ownershipFiles.length >= 20,
    "ownership document census is vacuous",
  );
});

test("every named finding has a direct owner or an exact disposition", () => {
  const unowned = [...findingIds]
    .filter(
      (findingId) =>
        !ownershipCorpus.includes(findingId) &&
        !Object.hasOwn(explicitDispositions, findingId),
    )
    .sort();
  assert.deepEqual(unowned, []);
});

test("every explicit disposition still names a real source finding", () => {
  const stale = Object.keys(explicitDispositions)
    .filter((findingId) => !findingIds.has(findingId))
    .sort();
  assert.deepEqual(stale, []);
});

test("aliases resolve to durable owning identifiers", () => {
  for (const [findingId, disposition] of Object.entries(explicitDispositions)) {
    if (disposition.kind !== "alias") {
      continue;
    }
    for (const ownerId of disposition.owners) {
      assert.ok(
        ownershipCorpus.includes(ownerId),
        `${findingId} aliases missing owner ${ownerId}`,
      );
    }
  }
});

test("source-resolved findings retain their fix evidence", () => {
  for (const [findingId, disposition] of Object.entries(explicitDispositions)) {
    if (disposition.kind !== "resolved-in-source") {
      continue;
    }
    const source = findingSources.get(disposition.source);
    assert.ok(source, `${findingId} names an unknown source document`);
    const section = markdownSectionContaining(source, findingId);
    for (const evidence of disposition.evidence) {
      assert.ok(
        section.includes(evidence),
        `${findingId} lost resolved evidence ${evidence}`,
      );
    }
  }
});

test("the PNTS retention finding has both promised durable records", () => {
  const findingId = "NEW-PNTS-TYPEDARRAY-RETENTION-RECORD";
  const deferredWork = readMigrationFile("DEFERRED_WORK.md");
  const featureInventory = readMigrationFile("FEATURE_INVENTORY.md");
  assert.ok(deferredWork.includes(`## ${findingId} / FAR-204`));
  assert.ok(featureInventory.includes(findingId));
  assert.ok(deferredWork.includes("requiresVertexTypedArrayRetention"));
  assert.ok(featureInventory.includes("requiresVertexTypedArrayRetention"));
});

test("the archived non-PASS disposition ledger is exact and non-vacuous", () => {
  assert.equal(dispositionLedger.schema, "cesium-finding-dispositions/v1");
  assert.equal(dispositionLedger.asOf, "2026-08-13");
  assert.equal(dispositionLedger.source.archivedNonPassCount, 23);
  assert.equal(dispositionLedger.entries.length, 23);

  const entryKeys = dispositionLedger.entries.map(
    ({ producer, runId }) => `${producer}/${runId}`,
  );
  assert.equal(new Set(entryKeys).size, entryKeys.length);

  const validStatuses = new Set(["ERROR", "FAIL", "STRUCTURAL"]);
  const validCategories = new Set([
    "harness",
    "mixed",
    "operational",
    "product",
  ]);
  const validDispositions = new Set([
    "active-repair",
    "closed-by-certifying-pass",
  ]);
  for (const entry of dispositionLedger.entries) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "category",
      "disposition",
      "owner",
      "producer",
      "runId",
      "status",
      "summary",
    ]);
    assert.match(entry.runId, uuidV4Pattern);
    assert.ok(validStatuses.has(entry.status));
    assert.ok(validCategories.has(entry.category));
    assert.ok(validDispositions.has(entry.disposition));
    assert.ok(entry.summary.length >= 40);
    assert.ok(
      Object.hasOwn(dispositionLedger.owners, entry.owner),
      `${entry.runId} has unknown owner ${entry.owner}`,
    );
    // A vacated closure keeps its entries: the runs happened and were closed by
    // a pass that has since been superseded, so `closed-by-certifying-pass` may
    // name a `closed` OR a `reopened` owner. `active-repair` still may not.
    const expectedOwnerStates = ownerStatesByDisposition[entry.disposition];
    assert.ok(
      expectedOwnerStates.includes(dispositionLedger.owners[entry.owner].state),
      `${entry.runId} disposition disagrees with ${entry.owner}`,
    );
  }

  assert.equal(
    dispositionLedger.entries.filter(
      ({ disposition }) => disposition === "closed-by-certifying-pass",
    ).length,
    20,
  );
  assert.equal(
    dispositionLedger.entries.filter(
      ({ disposition }) => disposition === "active-repair",
    ).length,
    3,
  );
});

test("the owner state model admits reopened, and reopened must name its ruling", () => {
  const closed = Object.freeze({
    document: "QUEUE_2026-07-19_CAMPAIGN12.md",
    reference: "C12-37",
    state: "closed",
    closureRunId: "1f437ee9-37e5-4d17-94a1-a269e81679ab",
  });
  const active = Object.freeze({
    document: "QUEUE_2026-07-19_CAMPAIGN12.md",
    reference: "custom-ellipsoid runtime",
    state: "active",
  });
  const reopened = Object.freeze({
    ...closed,
    state: "reopened",
    reopenedBy: "R-2026-08-14-1",
    reopenedRecordedBy: "R-2026-08-17-7",
    priorState: "closed",
    closureRunAnnotation:
      "a genuine PASS of a gate that has since been superseded",
  });

  // REACHABILITY / INERTNESS. This is the tooth that catches a `reopened`
  // branch made unreachable: with the branch inert a well-formed reopened owner
  // falls through to the unknown-state or key-set refusal and this throws.
  assertOwnerShape("reopened-fixture", reopened);
  assertOwnerShape("closed-fixture", closed);
  assertOwnerShape("active-fixture", active);

  const reject = (owner, why) =>
    assert.throws(() => assertOwnerShape("fixture", owner), undefined, why);

  // A reopened entry that does not name the ruling that overturned it.
  const { reopenedBy: _reopenedBy, ...withoutRuling } = reopened;
  reject(withoutRuling, "reopened without reopenedBy must fail");
  reject(
    { ...reopened, reopenedBy: "R-2026-8-14-1" },
    "a malformed ruling id must fail",
  );
  reject(
    { ...reopened, reopenedBy: "the 2026-08-14 packet" },
    "prose in place of a ruling id must fail",
  );

  // History is not rewritten: the closure run survives the vacate.
  const { closureRunId: _closureRunId, ...withoutHistory } = reopened;
  reject(withoutHistory, "reopened must retain closureRunId");
  reject(
    { ...reopened, closureRunId: "not-a-uuid" },
    "a malformed closureRunId must fail",
  );

  // The model is closed over its three states and their declared keys.
  reject({ ...reopened, state: "vacated" }, "an unknown state must fail");
  reject(
    { ...reopened, supersededBy: "R-2026-08-14-1" },
    "an undeclared key must fail",
  );
  reject({ ...reopened, priorState: "active" }, "priorState must be closed");
  reject(
    { ...closed, state: "reopened" },
    "closed keys alone do not satisfy reopened",
  );

  assert.deepEqual(Object.keys(ownerStateModel).sort(), [
    "active",
    "closed",
    "reopened",
  ]);
  // The disposition mapping is exact: a certifying pass may name a closure that
  // still stands or one that was vacated, and never an active repair.
  assert.deepEqual(ownerStatesByDisposition, {
    "active-repair": ["active"],
    "closed-by-certifying-pass": ["closed", "reopened"],
  });
});

test("every visual-evidence owner resolves to a durable queue record", () => {
  for (const [ownerId, owner] of Object.entries(dispositionLedger.owners)) {
    assertOwnerShape(ownerId, owner);
    const ownerDocument = readMigrationFile(owner.document);
    assert.ok(
      ownerDocument.includes(owner.reference),
      `${ownerId} lost queue reference ${owner.reference}`,
    );
    if (owner.state === "reopened") {
      const reopeningDocument = readMigrationFile(owner.document);
      assert.ok(
        reopeningDocument.includes(owner.reopenedBy),
        `${ownerId} names ${owner.reopenedBy} but its document does not`,
      );
    }
  }
});

const externalEvidenceLibraryRoot =
  process.env.CESIUM_VISUAL_EVIDENCE_LIBRARY_ROOT;
if (externalEvidenceLibraryRoot) {
  test("the disposition snapshot covers the external non-PASS archive exactly", () => {
    const archiveEntries = walkFilesNamed(
      path.join(externalEvidenceLibraryRoot, "runs"),
      "manifest.json",
    )
      .map((manifestPath) => JSON.parse(readFileSync(manifestPath, "utf8")))
      .filter(({ result }) => result.status !== "PASS")
      .map(({ producer, runId, result }) => ({
        key: `${producer}/${runId}`,
        status: result.status,
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
    const ledgerEntries = dispositionLedger.entries
      .map(({ producer, runId, status }) => ({
        key: `${producer}/${runId}`,
        status,
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
    assert.deepEqual(ledgerEntries, archiveEntries);
  });
}
