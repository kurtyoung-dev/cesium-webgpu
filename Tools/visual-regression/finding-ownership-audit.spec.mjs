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
    const expectedOwnerState =
      entry.disposition === "active-repair" ? "active" : "closed";
    assert.equal(
      dispositionLedger.owners[entry.owner].state,
      expectedOwnerState,
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

test("every visual-evidence owner resolves to a durable queue record", () => {
  for (const [ownerId, owner] of Object.entries(dispositionLedger.owners)) {
    assert.deepEqual(
      Object.keys(owner).sort(),
      owner.state === "closed"
        ? ["closureRunId", "document", "reference", "state"]
        : ["document", "reference", "state"],
    );
    const ownerDocument = readMigrationFile(owner.document);
    assert.ok(
      ownerDocument.includes(owner.reference),
      `${ownerId} lost queue reference ${owner.reference}`,
    );
    if (owner.state === "closed") {
      assert.match(owner.closureRunId, uuidV4Pattern);
    } else {
      assert.equal(owner.state, "active");
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
