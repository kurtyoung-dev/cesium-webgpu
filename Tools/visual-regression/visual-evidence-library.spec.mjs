import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  StructuralEvidenceError,
  VISUAL_EVIDENCE_CATALOG_SCHEMA,
  VISUAL_EVIDENCE_LEGACY_SCHEMA,
  VISUAL_EVIDENCE_PLAN_SCHEMA,
  VISUAL_EVIDENCE_SCHEMA,
  VISUAL_EVIDENCE_UPGRADE_PLAN_SCHEMA,
  VISUAL_EVIDENCE_VERIFY_SCHEMA,
  archiveVisualEvidence,
  buildVisualEvidenceCatalog,
  collectRepositoryProvenance,
  deriveDefaultVisualEvidenceRoot,
  planVisualEvidenceLibraryUpgrade,
  upgradeVisualEvidenceLibrary,
  verifyVisualEvidenceLibrary,
} from "./lib/visual-evidence-library.mjs";
import {
  VisualEvidenceUsageError,
  parseVisualEvidenceArguments,
  runVisualEvidenceCommand,
} from "./visual-evidence-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "..", "..");
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_RUN_ID = "22222222-2222-4222-8222-222222222222";
const FIXED_TIME = "2026-08-12T14:00:00.000Z";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function forwardFs(overrides = {}) {
  return Object.assign(Object.create(fs), overrides);
}

function makeFixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "visual-evidence-library-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(
    sourceRoot,
    "Tools",
    "visual-regression",
    "output",
  );
  const producerDirectory = path.join(outputRoot, "probe-fixture");
  const libraryRoot = path.join(root, "library");
  fs.mkdirSync(producerDirectory, { recursive: true });
  const artifact = path.join(producerDirectory, "fixture.latest.json");
  const image = path.join(producerDirectory, "frame.png");
  const duplicateImage = path.join(producerDirectory, "frame-copy.png");
  fs.writeFileSync(image, Buffer.from("synthetic-png-evidence\n"));
  fs.copyFileSync(image, duplicateImage);

  const provenance = {
    capturedAt: FIXED_TIME,
    worktreeRoot: sourceRoot,
    primaryRoot: sourceRoot,
    gitDirectory: path.join(sourceRoot, ".git"),
    gitCommonDirectory: path.join(sourceRoot, ".git"),
    head: "a".repeat(40),
    branch: "main",
    detached: false,
    dirty: true,
    statusByteLength: 7,
    statusSha256: "b".repeat(64),
    statusTokenCount: 1,
  };
  const provenanceCollector = () => structuredClone(provenance);
  const now = () => new Date(FIXED_TIME);

  function writeArtifact({
    runId = RUN_ID,
    status = "PASS",
    exitCode = 0,
    incomplete = false,
  } = {}) {
    fs.writeFileSync(
      artifact,
      `${JSON.stringify(
        {
          schema: "fixture/v1",
          runId,
          status,
          exitCode,
          incomplete,
        },
        null,
        2,
      )}\n`,
    );
  }
  writeArtifact();

  return {
    root,
    sourceRoot,
    outputRoot,
    producerDirectory,
    libraryRoot,
    artifact,
    image,
    duplicateImage,
    provenance,
    provenanceCollector,
    now,
    writeArtifact,
  };
}

function relativeToSource(fixture, file) {
  return path.relative(fixture.sourceRoot, file);
}

function archiveRun(fixture, overrides = {}, dependencies = {}) {
  return archiveVisualEvidence(
    {
      kind: "run",
      sourceRoot: fixture.sourceRoot,
      libraryRoot: fixture.libraryRoot,
      producer: "fixture-probe",
      runId: RUN_ID,
      status: "PASS",
      exitCode: 0,
      artifact: relativeToSource(fixture, fixture.artifact),
      files: [relativeToSource(fixture, fixture.image)],
      directories: [],
      command: "node probe-fixture.mjs",
      ...overrides,
    },
    {
      now: fixture.now,
      provenanceCollector: fixture.provenanceCollector,
      ...dependencies,
    },
  );
}

function manifestFiles(result) {
  return new Map(
    result.manifest.files.map((entry) => [entry.originalPath, entry]),
  );
}

function makeWritable(file) {
  fs.chmodSync(file, 0o666);
}

function preciseFileKey(file) {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function rewriteProtectedJson(file, value) {
  makeWritable(file);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, 0o444);
  return bytes;
}

function convertPublicationToLegacy(fixture, result) {
  const manifest = structuredClone(result.manifest);
  manifest.schema = VISUAL_EVIDENCE_LEGACY_SCHEMA;
  manifest.schemaVersion = 1;
  delete manifest.upgradedFrom;
  manifest.integrity = {
    sourcePrePostStable: true,
    repositoryPrePostStable: true,
    activeLockAbsentAtPreflightAndPostflight: true,
    runningOrIncompleteMarkerAbsent: true,
    contentAddressedObjectsVerified: true,
    originalPathViewsAreHardlinks: true,
    publicationNoClobber: true,
  };
  for (const entry of manifest.files) {
    const object = path.join(
      fixture.libraryRoot,
      ...entry.objectPath.split("/"),
    );
    const view = path.join(
      result.publicationDirectory,
      ...entry.viewPath.split("/"),
    );
    fs.unlinkSync(view);
    fs.linkSync(object, view);
  }
  const manifestBytes = rewriteProtectedJson(result.manifestFile, manifest);
  const sidecar = path.join(result.publicationDirectory, "manifest.sha256");
  makeWritable(sidecar);
  fs.writeFileSync(sidecar, `${sha256(manifestBytes)}\n`);
  return { manifest, manifestBytes, sidecar };
}

test("default library root is the external sibling of the Git common repository", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "visual-evidence-layout-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, "cesium-webgpu");
  const linked = path.join(root, "cesium-webgpu-evidence");
  const linkedAdmin = path.join(
    primary,
    ".git",
    "worktrees",
    "cesium-webgpu-evidence",
  );
  fs.mkdirSync(linkedAdmin, { recursive: true });
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(linkedAdmin, "commondir"), "../..\n");
  fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${linkedAdmin}\n`);
  const expected = path.join(root, "cesium-webgpu-visual-evidence");
  assert.equal(deriveDefaultVisualEvidenceRoot(primary), expected);
  assert.equal(deriveDefaultVisualEvidenceRoot(linked), expected);

  const actualExpected = path.resolve(
    REPOSITORY_ROOT,
    "..",
    `${path.basename(REPOSITORY_ROOT)}-visual-evidence`,
  );
  assert.equal(
    deriveDefaultVisualEvidenceRoot(REPOSITORY_ROOT),
    actualExpected,
  );
  assert.equal(
    actualExpected,
    path.normalize("F:/Dev/GH/cesium-webgpu-visual-evidence"),
  );
});

test("Git provenance collection disables optional index writes and fsmonitor hooks", () => {
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("rev-parse")) {
      return Buffer.from(`${"a".repeat(40)}\n`);
    }
    if (args.includes("symbolic-ref")) {
      return Buffer.from("main\n");
    }
    if (args.includes("status")) {
      return Buffer.alloc(0);
    }
    assert.fail(`unexpected Git arguments: ${args.join(" ")}`);
  };
  const provenance = collectRepositoryProvenance(REPOSITORY_ROOT, {
    execute,
    now: () => new Date(FIXED_TIME),
  });
  assert.equal(provenance.head, "a".repeat(40));
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, "git");
    assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, "0");
    assert.ok(call.args.includes("core.fsmonitor=false"));
  }
});

test("archive publishes protected objects, independent views, provenance, verify, and catalog", (t) => {
  const fixture = makeFixture(t);
  const result = archiveRun(fixture, {
    files: [
      relativeToSource(fixture, fixture.image),
      relativeToSource(fixture, fixture.duplicateImage),
    ],
  });
  assert.equal(result.manifest.schema, VISUAL_EVIDENCE_SCHEMA);
  assert.equal(result.manifest.kind, "run");
  assert.equal(result.manifest.result.status, "PASS");
  assert.equal(result.manifest.result.exitCode, 0);
  assert.equal(result.manifest.result.certificationEligible, true);
  assert.equal(result.manifest.integrity.publicationNoClobber, true);
  assert.equal(result.manifest.files.length, 3);
  assert.equal(result.objectCount, 2);
  assert.equal(fs.existsSync(fixture.image), true);

  for (const entry of result.manifest.files) {
    const object = path.join(
      fixture.libraryRoot,
      ...entry.objectPath.split("/"),
    );
    const view = path.join(
      result.publicationDirectory,
      ...entry.viewPath.split("/"),
    );
    const objectStat = fs.statSync(object);
    const viewStat = fs.statSync(view);
    assert.notEqual(preciseFileKey(object), preciseFileKey(view));
    assert.equal(objectStat.mode & 0o222, 0);
    assert.equal(viewStat.mode & 0o222, 0);
    assert.equal(sha256(fs.readFileSync(object)), entry.sha256);
  }

  const verification = verifyVisualEvidenceLibrary(
    { libraryRoot: fixture.libraryRoot },
    { now: fixture.now },
  );
  assert.equal(verification.schema, VISUAL_EVIDENCE_VERIFY_SCHEMA);
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
  assert.equal(verification.publications.length, 1);
  assert.equal(verification.objects.count, 2);
  assert.deepEqual(verification.objects.orphaned, []);

  const catalog = buildVisualEvidenceCatalog(
    { libraryRoot: fixture.libraryRoot },
    { now: fixture.now },
  );
  assert.equal(catalog.schema, VISUAL_EVIDENCE_CATALOG_SCHEMA);
  assert.equal(catalog.publicationCount, 1);
  assert.equal(catalog.libraryLabel, path.basename(fixture.libraryRoot));
  assert.equal("libraryRoot" in catalog, false);
  assert.doesNotMatch(
    JSON.stringify(catalog),
    new RegExp(fixture.root.replaceAll("\\", "\\\\"), "u"),
  );
  assert.equal(catalog.entries[0].runId, RUN_ID);
  assert.equal(catalog.entries[0].files.length, 3);
});

test("same producer/runId publication is no-clobber and retains exact first bytes", (t) => {
  const fixture = makeFixture(t);
  const first = archiveRun(fixture);
  const firstManifest = fs.readFileSync(first.manifestFile);
  const retry = archiveRun(fixture);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.manifestSha256, first.manifestSha256);
  assert.deepEqual(fs.readFileSync(first.manifestFile), firstManifest);
  fixture.writeArtifact({ status: "FAIL", exitCode: 1 });
  assert.throws(
    () =>
      archiveRun(fixture, {
        status: "FAIL",
        exitCode: 1,
      }),
    /publication already exists with a different archival identity/u,
  );
  assert.deepEqual(fs.readFileSync(first.manifestFile), firstManifest);
  const verification = verifyVisualEvidenceLibrary({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
});

test("idempotent retry rejects changed provenance identity", (t) => {
  const fixture = makeFixture(t);
  archiveRun(fixture);
  fixture.provenance.head = "c".repeat(40);
  assert.throws(
    () => archiveRun(fixture),
    /publication already exists with a different archival identity/u,
  );
  const verification = verifyVisualEvidenceLibrary({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
});

test("source and library junction traversal fail closed", async (t) => {
  await t.test("source ancestor junction", (t) => {
    const fixture = makeFixture(t);
    const outside = path.join(fixture.root, "outside");
    fs.mkdirSync(outside);
    const outsideArtifact = path.join(outside, "run.json");
    fs.writeFileSync(
      outsideArtifact,
      `${JSON.stringify({ runId: RUN_ID, status: "PASS", exitCode: 0 })}\n`,
    );
    const portal = path.join(fixture.sourceRoot, "portal");
    fs.symlinkSync(outside, portal, "junction");
    assert.throws(
      () =>
        archiveRun(fixture, {
          artifact: path.join("portal", "run.json"),
          files: [],
          guardRoot: "portal",
        }),
      /traverses a symbolic link or junction/u,
    );
  });

  await t.test("library object-store junction", (t) => {
    const fixture = makeFixture(t);
    const outside = path.join(fixture.root, "outside-objects");
    fs.mkdirSync(fixture.libraryRoot);
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(fixture.libraryRoot, "objects"),
      "junction",
    );
    assert.throws(
      () => archiveRun(fixture),
      /symbolic link, junction, or non-directory/u,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  await t.test("source-root ancestor junction", (t) => {
    const fixture = makeFixture(t);
    const portal = path.join(fixture.root, "source-portal");
    fs.symlinkSync(fixture.root, portal, "junction");
    assert.throws(
      () =>
        archiveRun(fixture, {
          sourceRoot: path.join(portal, "source"),
          artifact: path.relative(fixture.sourceRoot, fixture.artifact),
          files: [path.relative(fixture.sourceRoot, fixture.image)],
        }),
      /source root traverses a symbolic link or junction/u,
    );
  });

  await t.test("library-root ancestor junction", (t) => {
    const fixture = makeFixture(t);
    const outside = path.join(fixture.root, "outside-library");
    const portal = path.join(fixture.root, "library-portal");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, portal, "junction");
    assert.throws(
      () =>
        archiveRun(fixture, {
          libraryRoot: path.join(portal, "library"),
        }),
      /library root traverses a symbolic link or junction/u,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

test("PASS evidence requires a zero exit code even when artifact omits it", (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(
    fixture.artifact,
    `${JSON.stringify({ runId: RUN_ID, status: "PASS", incomplete: false })}\n`,
  );
  assert.throws(
    () => archiveRun(fixture, { exitCode: 1 }),
    /PASS evidence requires exitCode 0/u,
  );
});

test("content objects deduplicate across distinct immutable publications", (t) => {
  const fixture = makeFixture(t);
  const first = archiveRun(fixture);
  fixture.writeArtifact({ runId: SECOND_RUN_ID });
  const second = archiveRun(fixture, { runId: SECOND_RUN_ID });
  const firstImage = manifestFiles(first).get(
    relativeToSource(fixture, fixture.image).split(path.sep).join("/"),
  );
  const secondImage = manifestFiles(second).get(
    relativeToSource(fixture, fixture.image).split(path.sep).join("/"),
  );
  assert.equal(firstImage.objectPath, secondImage.objectPath);
  assert.ok(second.reusedObjectCount >= 1);
  const verification = verifyVisualEvidenceLibrary({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
  assert.equal(verification.publications.length, 2);
});

test("an active lock anywhere in visual output refuses publication", (t) => {
  const fixture = makeFixture(t);
  const lock = path.join(fixture.outputRoot, "another-probe", "active.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "owned\n");
  assert.throws(
    () => archiveRun(fixture),
    (error) =>
      error instanceof StructuralEvidenceError &&
      /active visual-evidence lock/u.test(error.message),
  );
  assert.equal(
    fs.existsSync(
      path.join(fixture.libraryRoot, "runs", "fixture-probe", RUN_ID),
    ),
    false,
  );
});

test("RUNNING and incomplete authoritative artifacts refuse publication", async (t) => {
  await t.test("RUNNING", (t) => {
    const fixture = makeFixture(t);
    fixture.writeArtifact({ status: "RUNNING", exitCode: null });
    assert.throws(() => archiveRun(fixture), /RUNNING\/incomplete artifact/u);
  });
  await t.test("incomplete", (t) => {
    const fixture = makeFixture(t);
    fixture.writeArtifact({ status: "ERROR", exitCode: 2, incomplete: true });
    assert.throws(
      () => archiveRun(fixture, { status: "ERROR", exitCode: 2 }),
      /RUNNING\/incomplete artifact/u,
    );
  });
});

test("authoritative artifact identity and verdict must equal the CLI contract", async (t) => {
  for (const fixtureCase of [
    {
      name: "runId",
      artifact: { runId: SECOND_RUN_ID },
      override: {},
      expected: /runId .* does not match/u,
    },
    {
      name: "status",
      artifact: { status: "FAIL", exitCode: 1 },
      override: {},
      expected: /status FAIL does not match PASS/u,
    },
    {
      name: "exitCode",
      artifact: { exitCode: 1 },
      override: {},
      expected: /exitCode 1 does not match 0/u,
    },
  ]) {
    await t.test(fixtureCase.name, (t) => {
      const fixture = makeFixture(t);
      fixture.writeArtifact(fixtureCase.artifact);
      assert.throws(
        () => archiveRun(fixture, fixtureCase.override),
        fixtureCase.expected,
      );
    });
  }
});

test("source byte mutation during publication is detected and no run becomes visible", (t) => {
  const fixture = makeFixture(t);
  let mutated = false;
  const operations = forwardFs({
    copyFileSync(source, destination, flags) {
      fs.copyFileSync(source, destination, flags);
      if (!mutated && destination.includes(`${path.sep}.incoming${path.sep}`)) {
        mutated = true;
        fs.appendFileSync(fixture.image, "changed\n");
      }
    },
  });
  assert.throws(
    () => archiveRun(fixture, {}, { operations }),
    /source file changed during archival/u,
  );
  assert.equal(
    fs.existsSync(
      path.join(fixture.libraryRoot, "runs", "fixture-probe", RUN_ID),
    ),
    false,
  );
  const verification = verifyVisualEvidenceLibrary({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
  assert.ok(verification.objects.orphaned.length >= 1);
});

test("recursive source membership changes between preflight and postflight", (t) => {
  const fixture = makeFixture(t);
  let mutated = false;
  const operations = forwardFs({
    copyFileSync(source, destination, flags) {
      fs.copyFileSync(source, destination, flags);
      if (!mutated && destination.includes(`${path.sep}.incoming${path.sep}`)) {
        mutated = true;
        fs.writeFileSync(
          path.join(fixture.producerDirectory, "late.png"),
          "late\n",
        );
      }
    },
  });
  assert.throws(
    () =>
      archiveRun(
        fixture,
        {
          files: [],
          directories: [relativeToSource(fixture, fixture.producerDirectory)],
        },
        { operations },
      ),
    /source selection changed during archival/u,
  );
});

test("a lock appearing during archival refuses final publication", (t) => {
  const fixture = makeFixture(t);
  let mutated = false;
  const operations = forwardFs({
    copyFileSync(source, destination, flags) {
      fs.copyFileSync(source, destination, flags);
      if (!mutated && destination.includes(`${path.sep}.incoming${path.sep}`)) {
        mutated = true;
        fs.writeFileSync(
          path.join(fixture.outputRoot, "appeared.lock"),
          "late\n",
        );
      }
    },
  });
  assert.throws(
    () => archiveRun(fixture, {}, { operations }),
    /active visual-evidence lock/u,
  );
});

test("repository HEAD or dirty-state mutation during archival refuses publication", (t) => {
  const fixture = makeFixture(t);
  let callCount = 0;
  const provenanceCollector = () => {
    callCount++;
    return {
      ...structuredClone(fixture.provenance),
      head: callCount === 1 ? "a".repeat(40) : "c".repeat(40),
    };
  };
  assert.throws(
    () => archiveRun(fixture, {}, { provenanceCollector }),
    /repository provenance changed during archival: head/u,
  );
});

test("malformed selected JSON and source-root escape fail closed", async (t) => {
  await t.test("malformed JSON", (t) => {
    const fixture = makeFixture(t);
    const malformed = path.join(fixture.producerDirectory, "malformed.json");
    fs.writeFileSync(malformed, "{not-json\n");
    assert.throws(
      () =>
        archiveRun(fixture, {
          files: [relativeToSource(fixture, malformed)],
        }),
      /selected JSON is malformed/u,
    );
  });
  await t.test("path escape", (t) => {
    const fixture = makeFixture(t);
    const outside = path.join(fixture.root, "outside.png");
    fs.writeFileSync(outside, "outside\n");
    assert.throws(
      () =>
        archiveRun(fixture, {
          files: [outside],
        }),
      /escapes source root/u,
    );
  });
  await t.test("overlapping roots", (t) => {
    const fixture = makeFixture(t);
    assert.throws(
      () =>
        archiveRun(fixture, {
          libraryRoot: path.join(fixture.sourceRoot, "library"),
        }),
      /must be disjoint directories/u,
    );
  });
});

test("legacy imports require an explicit namespace and remain non-certifying", (t) => {
  const fixture = makeFixture(t);
  const options = {
    kind: "legacy-import",
    sourceRoot: fixture.sourceRoot,
    libraryRoot: fixture.libraryRoot,
    namespace: "main-pre-library",
    producer: "historical-voxel",
    runId: "legacy-20260812-001",
    reason: "Preserve pre-library bytes without interpreting their verdict",
    status: "NON_CERTIFYING",
    exitCode: null,
    files: [relativeToSource(fixture, fixture.image)],
    directories: [],
  };
  const dependencies = {
    now: fixture.now,
    provenanceCollector: fixture.provenanceCollector,
  };
  assert.throws(
    () =>
      archiveVisualEvidence(
        { ...options, reason: `Imported from ${fixture.root}` },
        dependencies,
      ),
    /public reason without host paths/u,
  );
  assert.equal(fs.existsSync(fixture.libraryRoot), false);
  const result = archiveVisualEvidence(options, dependencies);
  assert.equal(result.manifest.kind, "legacy-import");
  assert.equal(result.manifest.namespace, "main-pre-library");
  assert.equal(result.manifest.result.status, "NON_CERTIFYING");
  assert.equal(result.manifest.result.exitCode, null);
  assert.equal(result.manifest.result.certificationEligible, false);
  assert.equal(result.manifest.legacyImport.certificationEligible, false);
  assert.equal(result.manifest.files[0].role, "file");
  const verification = verifyVisualEvidenceLibrary({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
  const catalog = buildVisualEvidenceCatalog({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(catalog.entries[0].namespace, "main-pre-library");
  assert.equal(catalog.entries[0].certificationEligible, false);

  const forged = JSON.parse(fs.readFileSync(result.manifestFile, "utf8"));
  forged.legacyImport.reason = `Imported from ${fixture.root}`;
  const forgedBytes = rewriteProtectedJson(result.manifestFile, forged);
  const sidecar = path.join(result.publicationDirectory, "manifest.sha256");
  makeWritable(sidecar);
  fs.writeFileSync(sidecar, `${sha256(forgedBytes)}\n`);
  fs.chmodSync(sidecar, 0o444);
  const forgedVerification = verifyVisualEvidenceLibrary({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(forgedVerification.valid, false);
  assert.throws(
    () => buildVisualEvidenceCatalog({ libraryRoot: fixture.libraryRoot }),
    /verification failed before cataloging/u,
  );
});

test("verification detects corrupt objects, hardlinked views, and unmanifested files", async (t) => {
  await t.test("object corruption", (t) => {
    const fixture = makeFixture(t);
    const result = archiveRun(fixture);
    const imageEntry = result.manifest.files.find(
      (entry) => entry.mediaType === "image/png",
    );
    const object = path.join(
      fixture.libraryRoot,
      ...imageEntry.objectPath.split("/"),
    );
    makeWritable(object);
    fs.writeFileSync(object, "corrupt\n");
    const verification = verifyVisualEvidenceLibrary({
      libraryRoot: fixture.libraryRoot,
    });
    assert.equal(verification.valid, false);
    assert.ok(
      verification.reasons.some((reason) =>
        /object hash does not match its path/u.test(reason),
      ),
    );
  });
  await t.test("hardlinked view", (t) => {
    const fixture = makeFixture(t);
    const result = archiveRun(fixture);
    const imageEntry = result.manifest.files.find(
      (entry) => entry.mediaType === "image/png",
    );
    const object = path.join(
      fixture.libraryRoot,
      ...imageEntry.objectPath.split("/"),
    );
    const view = path.join(
      result.publicationDirectory,
      ...imageEntry.viewPath.split("/"),
    );
    fs.unlinkSync(view);
    fs.linkSync(object, view);
    const verification = verifyVisualEvidenceLibrary({
      libraryRoot: fixture.libraryRoot,
    });
    assert.equal(verification.valid, false);
    assert.ok(
      verification.reasons.some((reason) =>
        /view is not independent from its object/u.test(reason),
      ),
    );
  });
  await t.test("unmanifested file", (t) => {
    const fixture = makeFixture(t);
    const result = archiveRun(fixture);
    fs.writeFileSync(
      path.join(result.publicationDirectory, "extra.txt"),
      "x\n",
    );
    const verification = verifyVisualEvidenceLibrary({
      libraryRoot: fixture.libraryRoot,
    });
    assert.equal(verification.valid, false);
    assert.ok(
      verification.reasons.some((reason) =>
        /unmanifested file exists/u.test(reason),
      ),
    );
  });
  await t.test("unverified objects-root bytes", (t) => {
    const fixture = makeFixture(t);
    archiveRun(fixture);
    fs.writeFileSync(
      path.join(fixture.libraryRoot, "objects", "credential.txt"),
      "SECRET-VALUE\n",
    );
    const verification = verifyVisualEvidenceLibrary({
      libraryRoot: fixture.libraryRoot,
    });
    assert.equal(verification.valid, false);
    assert.ok(
      verification.reasons.some((reason) =>
        /unsupported objects-root entry/u.test(reason),
      ),
    );
    assert.throws(
      () => buildVisualEvidenceCatalog({ libraryRoot: fixture.libraryRoot }),
      /verification failed before cataloging/u,
    );
  });
  await t.test("unmanifested empty publication directory", (t) => {
    const fixture = makeFixture(t);
    const result = archiveRun(fixture);
    fs.mkdirSync(path.join(result.publicationDirectory, "unmanifested-empty"));
    const verification = verifyVisualEvidenceLibrary({
      libraryRoot: fixture.libraryRoot,
    });
    assert.equal(verification.valid, false);
    assert.ok(
      verification.reasons.some((reason) =>
        /unmanifested directory exists/u.test(reason),
      ),
    );
  });
});

test("verification detects a logically forged manifest even with a refreshed sidecar", (t) => {
  const fixture = makeFixture(t);
  const result = archiveRun(fixture);
  const manifest = JSON.parse(fs.readFileSync(result.manifestFile, "utf8"));
  manifest.integrity.sourcePrePostStable = false;
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  makeWritable(result.manifestFile);
  const sidecar = path.join(result.publicationDirectory, "manifest.sha256");
  makeWritable(sidecar);
  fs.writeFileSync(result.manifestFile, bytes);
  fs.writeFileSync(sidecar, `${sha256(bytes)}\n`);
  const verification = verifyVisualEvidenceLibrary({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(verification.valid, false);
  assert.ok(
    verification.reasons.some((reason) =>
      /integrity claims are incomplete/u.test(reason),
    ),
  );
});

test("verification rejects refreshed semantic forgeries and extra root files", async (t) => {
  await t.test("manifest field forgery", (t) => {
    const fixture = makeFixture(t);
    const result = archiveRun(fixture);
    const manifest = JSON.parse(fs.readFileSync(result.manifestFile, "utf8"));
    manifest.publishedAt = "not-a-date";
    manifest.files[0].mediaType = "text/html";
    delete manifest.files[0].sourcePre.inode;
    delete manifest.source.repository.pre.statusTokenCount;
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    makeWritable(result.manifestFile);
    const sidecar = path.join(result.publicationDirectory, "manifest.sha256");
    makeWritable(sidecar);
    fs.writeFileSync(result.manifestFile, bytes);
    fs.writeFileSync(sidecar, `${sha256(bytes)}\n`);
    const verification = verifyVisualEvidenceLibrary({
      libraryRoot: fixture.libraryRoot,
    });
    assert.equal(verification.valid, false);
    assert.ok(
      verification.reasons.some((reason) =>
        /publishedAt is invalid|media type is invalid|provenance is malformed|source pre\/post identity differs/u.test(
          reason,
        ),
      ),
    );
  });

  await t.test("unmanifested top-level file", (t) => {
    const fixture = makeFixture(t);
    archiveRun(fixture);
    fs.writeFileSync(path.join(fixture.libraryRoot, "extra.txt"), "extra\n");
    const verification = verifyVisualEvidenceLibrary({
      libraryRoot: fixture.libraryRoot,
    });
    assert.equal(verification.valid, false);
    assert.ok(
      verification.reasons.some((reason) =>
        /unsupported top-level library entry/u.test(reason),
      ),
    );
  });
});

test("verification is total for parsed null and array manifests", async (t) => {
  for (const [name, forged] of [
    ["null", null],
    ["array", []],
  ]) {
    await t.test(name, (t) => {
      const fixture = makeFixture(t);
      const result = archiveRun(fixture);
      const bytes = rewriteProtectedJson(result.manifestFile, forged);
      const sidecar = path.join(result.publicationDirectory, "manifest.sha256");
      makeWritable(sidecar);
      fs.writeFileSync(sidecar, `${sha256(bytes)}\n`);
      fs.chmodSync(sidecar, 0o444);

      let verification;
      assert.doesNotThrow(() => {
        verification = verifyVisualEvidenceLibrary({
          libraryRoot: fixture.libraryRoot,
        });
      });
      assert.equal(verification.valid, false);
      assert.ok(
        verification.reasons.some((reason) =>
          /manifest JSON must be an object/u.test(reason),
        ),
      );
      assert.throws(
        () => buildVisualEvidenceCatalog({ libraryRoot: fixture.libraryRoot }),
        (error) =>
          error instanceof StructuralEvidenceError &&
          /verification failed before cataloging/u.test(error.message),
      );
    });
  }
});

test("mutating one independent view cannot alter its object or another run", (t) => {
  const fixture = makeFixture(t);
  const first = archiveRun(fixture);
  fixture.writeArtifact({ runId: SECOND_RUN_ID });
  const second = archiveRun(fixture, { runId: SECOND_RUN_ID });
  const original = fs.readFileSync(fixture.image);
  const firstEntry = first.manifest.files.find(
    (entry) => entry.mediaType === "image/png",
  );
  const secondEntry = second.manifest.files.find(
    (entry) => entry.mediaType === "image/png",
  );
  const object = path.join(
    fixture.libraryRoot,
    ...firstEntry.objectPath.split("/"),
  );
  const firstView = path.join(
    first.publicationDirectory,
    ...firstEntry.viewPath.split("/"),
  );
  const secondView = path.join(
    second.publicationDirectory,
    ...secondEntry.viewPath.split("/"),
  );
  makeWritable(firstView);
  fs.writeFileSync(firstView, "mutated-view\n");
  assert.deepEqual(fs.readFileSync(object), original);
  assert.deepEqual(fs.readFileSync(secondView), original);
  const verification = verifyVisualEvidenceLibrary({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(verification.valid, false);
  assert.ok(
    verification.reasons.some((reason) =>
      /view bytes differ|view is writable/u.test(reason),
    ),
  );
});

test("rounded numeric Windows file IDs cannot create a false hardlink refusal", (t) => {
  const fixture = makeFixture(t);
  const roundedInode = 9_851_624_187_343_176;
  let preciseStatCount = 0;
  const operations = forwardFs({
    lstatSync(file, options) {
      const stat = fs.lstatSync(file, options);
      if (options?.bigint === true) {
        preciseStatCount++;
        return stat;
      }
      return new Proxy(stat, {
        get(target, property) {
          if (property === "ino") {
            return roundedInode;
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    statSync(file, options) {
      const stat = fs.statSync(file, options);
      if (options?.bigint === true) {
        preciseStatCount++;
        return stat;
      }
      return new Proxy(stat, {
        get(target, property) {
          if (property === "ino") {
            return roundedInode;
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  const result = archiveRun(fixture, {}, { operations });
  assert.ok(preciseStatCount > 0);
  const verification = verifyVisualEvidenceLibrary(
    { libraryRoot: fixture.libraryRoot },
    { operations, now: fixture.now },
  );
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
  const entry = result.manifest.files.find(({ role }) => role === "file");
  assert.ok(entry);
  assert.notEqual(
    preciseFileKey(
      path.join(fixture.libraryRoot, ...entry.objectPath.split("/")),
    ),
    preciseFileKey(
      path.join(result.publicationDirectory, ...entry.viewPath.split("/")),
    ),
  );
});

test("many adjacent independent copies remain distinct and verifiable", (t) => {
  const fixture = makeFixture(t);
  const frames = path.join(fixture.producerDirectory, "stress-frames");
  fs.mkdirSync(frames);
  for (let index = 0; index < 192; index++) {
    fs.writeFileSync(
      path.join(frames, `frame-${String(index).padStart(3, "0")}.png`),
      `synthetic-frame-${index}\n`,
    );
  }
  const result = archiveRun(fixture, {
    files: [],
    directories: [relativeToSource(fixture, frames)],
  });
  assert.equal(result.manifest.files.length, 193);
  const verification = verifyVisualEvidenceLibrary(
    { libraryRoot: fixture.libraryRoot },
    { now: fixture.now },
  );
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
  for (const entry of result.manifest.files) {
    assert.notEqual(
      preciseFileKey(
        path.join(fixture.libraryRoot, ...entry.objectPath.split("/")),
      ),
      preciseFileKey(
        path.join(result.publicationDirectory, ...entry.viewPath.split("/")),
      ),
    );
  }
});

test("legacy upgrade plans without writes, applies transactionally, and is idempotent", (t) => {
  const fixture = makeFixture(t);
  const publication = archiveRun(fixture);
  const legacy = convertPublicationToLegacy(fixture, publication);
  const before = verifyVisualEvidenceLibrary({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(before.valid, false);
  assert.ok(
    before.reasons.some((reason) => /requires explicit upgrade/u.test(reason)),
  );

  const rejectWrite = () => assert.fail("upgrade plan attempted a write");
  const operations = forwardFs({
    chmodSync: rejectWrite,
    copyFileSync: rejectWrite,
    linkSync: rejectWrite,
    mkdirSync: rejectWrite,
    renameSync: rejectWrite,
    rmSync: rejectWrite,
    unlinkSync: rejectWrite,
    writeFileSync: rejectWrite,
  });
  const plan = planVisualEvidenceLibraryUpgrade(
    { libraryRoot: fixture.libraryRoot },
    { operations, now: fixture.now },
  );
  assert.equal(plan.schema, VISUAL_EVIDENCE_UPGRADE_PLAN_SCHEMA);
  assert.equal(plan.writesPerformed, false);
  assert.equal(plan.changesRequired, true);
  assert.equal(plan.legacyPublicationCount, 1);
  assert.deepEqual(
    fs.readFileSync(publication.manifestFile),
    legacy.manifestBytes,
  );

  const upgraded = upgradeVisualEvidenceLibrary(
    { libraryRoot: fixture.libraryRoot },
    { now: fixture.now },
  );
  assert.equal(upgraded.idempotent, false);
  assert.equal(upgraded.upgradedPublicationCount, 1);
  const verification = verifyVisualEvidenceLibrary({
    libraryRoot: fixture.libraryRoot,
  });
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
  const manifest = verification.publications[0].manifest;
  assert.equal(manifest.schema, VISUAL_EVIDENCE_SCHEMA);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.upgradedFrom.schema, VISUAL_EVIDENCE_LEGACY_SCHEMA);
  assert.equal(
    manifest.upgradedFrom.manifestSha256,
    sha256(legacy.manifestBytes),
  );
  const entry = manifest.files.find((file) => file.mediaType === "image/png");
  const object = path.join(fixture.libraryRoot, ...entry.objectPath.split("/"));
  const view = path.join(
    fixture.libraryRoot,
    ...manifest.publicationPath.split("/"),
    ...entry.viewPath.split("/"),
  );
  assert.notEqual(preciseFileKey(object), preciseFileKey(view));
  assert.equal(fs.statSync(object).mode & 0o222, 0);
  assert.equal(fs.statSync(view).mode & 0o222, 0);

  const retry = upgradeVisualEvidenceLibrary(
    { libraryRoot: fixture.libraryRoot },
    { now: fixture.now },
  );
  assert.equal(retry.idempotent, true);
  assert.equal(retry.upgradedPublicationCount, 0);
});

test("legacy upgrade restores the exact original library when the swap fails", (t) => {
  const fixture = makeFixture(t);
  const publication = archiveRun(fixture);
  const legacy = convertPublicationToLegacy(fixture, publication);
  const operations = forwardFs({
    renameSync(source, destination) {
      if (
        source.includes(".upgrade-stage-") &&
        path.resolve(destination) === path.resolve(fixture.libraryRoot)
      ) {
        const error = new Error("synthetic upgraded-store swap failure");
        error.code = "EIO";
        throw error;
      }
      fs.renameSync(source, destination);
    },
  });
  assert.throws(
    () =>
      upgradeVisualEvidenceLibrary(
        { libraryRoot: fixture.libraryRoot },
        { operations, now: fixture.now },
      ),
    /synthetic upgraded-store swap failure/u,
  );
  assert.deepEqual(
    fs.readFileSync(publication.manifestFile),
    legacy.manifestBytes,
  );
  const verification = verifyVisualEvidenceLibrary(
    { libraryRoot: fixture.libraryRoot, allowLegacy: true },
    { now: fixture.now },
  );
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
  assert.equal(
    verification.publications[0].manifest.schema,
    VISUAL_EVIDENCE_LEGACY_SCHEMA,
  );
  assert.deepEqual(
    fs
      .readdirSync(fixture.root)
      .filter((name) => name.startsWith("library.upgrade")),
    [],
  );
});

test("legacy upgrade rolls back when the swapped store fails final verification", (t) => {
  const fixture = makeFixture(t);
  const publication = archiveRun(fixture);
  const legacy = convertPublicationToLegacy(fixture, publication);
  const legacyEntry = legacy.manifest.files.find(
    (entry) => entry.mediaType === "image/png",
  );
  const legacyObject = path.join(
    fixture.libraryRoot,
    ...legacyEntry.objectPath.split("/"),
  );
  const legacyView = path.join(
    publication.publicationDirectory,
    ...legacyEntry.viewPath.split("/"),
  );
  const originalObjectKey = preciseFileKey(legacyObject);
  const originalViewKey = preciseFileKey(legacyView);
  assert.equal(originalObjectKey, originalViewKey);

  const operations = forwardFs({
    renameSync(source, destination) {
      fs.renameSync(source, destination);
      if (
        source.includes(".upgrade-stage-") &&
        path.resolve(destination) === path.resolve(fixture.libraryRoot)
      ) {
        fs.writeFileSync(
          path.join(destination, "injected-after-swap.txt"),
          "synthetic final-verification failure\n",
        );
      }
    },
  });
  assert.throws(
    () =>
      upgradeVisualEvidenceLibrary(
        { libraryRoot: fixture.libraryRoot },
        { operations, now: fixture.now },
      ),
    /published visual-evidence upgrade failed final verification/u,
  );
  assert.deepEqual(
    fs.readFileSync(publication.manifestFile),
    legacy.manifestBytes,
  );
  assert.equal(preciseFileKey(legacyObject), originalObjectKey);
  assert.equal(preciseFileKey(legacyView), originalViewKey);
  const verification = verifyVisualEvidenceLibrary(
    { libraryRoot: fixture.libraryRoot, allowLegacy: true },
    { now: fixture.now },
  );
  assert.equal(verification.valid, true, verification.reasons.join("\n"));
  assert.deepEqual(
    fs
      .readdirSync(fixture.root)
      .filter((name) => name.startsWith("library.upgrade")),
    [],
  );
});

test("CLI upgrade is plan-only by default and applies only with explicit consent", (t) => {
  const fixture = makeFixture(t);
  const publication = archiveRun(fixture);
  convertPublicationToLegacy(fixture, publication);
  const common = [
    "--source-root",
    fixture.sourceRoot,
    "--library-root",
    fixture.libraryRoot,
  ];
  const plan = runVisualEvidenceCommand(
    parseVisualEvidenceArguments(["upgrade", ...common]),
    { now: fixture.now },
  );
  assert.equal(plan.kind, "upgrade-plan");
  assert.equal(plan.plan.writesPerformed, false);
  assert.equal(
    JSON.parse(fs.readFileSync(publication.manifestFile, "utf8")).schema,
    VISUAL_EVIDENCE_LEGACY_SCHEMA,
  );
  const applied = runVisualEvidenceCommand(
    parseVisualEvidenceArguments(["upgrade", "--apply", ...common]),
    { now: fixture.now },
  );
  assert.equal(applied.kind, "upgrade");
  assert.equal(applied.result.upgradedPublicationCount, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(publication.manifestFile, "utf8")).schema,
    VISUAL_EVIDENCE_SCHEMA,
  );
  assert.throws(
    () =>
      runVisualEvidenceCommand(
        parseVisualEvidenceArguments(["verify", "--apply"]),
      ),
    /accepted only by upgrade/u,
  );
});

test("shared manifests redact host paths and raw source commands", (t) => {
  const fixture = makeFixture(t);
  const secret = "node probe.mjs --token SECRET-VALUE";
  const result = archiveRun(fixture, { command: secret });
  const manifestText = fs.readFileSync(result.manifestFile, "utf8");
  assert.doesNotMatch(manifestText, /SECRET-VALUE/u);
  assert.doesNotMatch(
    manifestText,
    new RegExp(fixture.root.replaceAll("\\", "\\\\"), "u"),
  );
  assert.equal(
    result.manifest.invocation.command.commandSha256,
    sha256(Buffer.from(secret)),
  );
});

test("verification rejects refreshed-sidecar unknown fields and false stability", async (t) => {
  const mutations = [
    [
      "top-level absolute host path",
      (manifest, fixture) => {
        manifest.absoluteHostPath = fixture.root;
      },
    ],
    [
      "result raw command",
      (manifest) => {
        manifest.result.rawCommand = "node probe --token SECRET-VALUE";
      },
    ],
    [
      "invocation raw command",
      (manifest) => {
        manifest.invocation.rawCommand = "node probe --token SECRET-VALUE";
      },
    ],
    [
      "file credential field",
      (manifest) => {
        manifest.files[0].credential = "SECRET-VALUE";
      },
    ],
    [
      "capture absolute host path",
      (manifest, fixture) => {
        manifest.files[0].sourcePre.absoluteHostPath = fixture.root;
      },
    ],
    [
      "repository pre host path",
      (manifest, fixture) => {
        manifest.source.repository.pre.worktreeRoot = fixture.root;
      },
    ],
    [
      "repository post command",
      (manifest) => {
        manifest.source.repository.post.command =
          "node probe --token SECRET-VALUE";
      },
    ],
    [
      "allowed guard field disguised as a Windows host path",
      (manifest) => {
        manifest.source.guardPath = "C:/Users/Kurt/private-output";
      },
    ],
    [
      "allowed branch field disguised as a raw command",
      (manifest) => {
        manifest.source.repository.pre.branch =
          "node probe --token SECRET-VALUE";
        manifest.source.repository.post.branch =
          "node probe --token SECRET-VALUE";
      },
    ],
    [
      "incoherent detached identity",
      (manifest) => {
        manifest.source.repository.pre.detached = true;
        manifest.source.repository.post.detached = true;
      },
    ],
    [
      "incoherent dirty identity",
      (manifest) => {
        manifest.source.repository.pre.dirty = false;
        manifest.source.repository.post.dirty = false;
      },
    ],
    [
      "normal-run legacy import",
      (manifest, fixture) => {
        manifest.legacyImport = {
          namespace: "forged",
          reason: fixture.root,
          certificationEligible: false,
        };
      },
    ],
    [
      "false repository stability",
      (manifest) => {
        manifest.source.repository.stable = false;
      },
    ],
    [
      "missing top-level field",
      (manifest) => {
        delete manifest.upgradedFrom;
      },
    ],
    [
      "missing nested field",
      (manifest) => {
        delete manifest.result.certificationEligible;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, (t) => {
      const fixture = makeFixture(t);
      const result = archiveRun(fixture);
      const manifest = JSON.parse(fs.readFileSync(result.manifestFile, "utf8"));
      mutate(manifest, fixture);
      const bytes = rewriteProtectedJson(result.manifestFile, manifest);
      const sidecar = path.join(result.publicationDirectory, "manifest.sha256");
      makeWritable(sidecar);
      fs.writeFileSync(sidecar, `${sha256(bytes)}\n`);
      fs.chmodSync(sidecar, 0o444);

      const verification = verifyVisualEvidenceLibrary({
        libraryRoot: fixture.libraryRoot,
      });
      assert.equal(verification.valid, false);
      assert.throws(
        () => buildVisualEvidenceCatalog({ libraryRoot: fixture.libraryRoot }),
        /verification failed before cataloging/u,
      );
    });
  }
});

test("verification refuses unfinished incoming work and active publication claims", async (t) => {
  await t.test("incoming", (t) => {
    const fixture = makeFixture(t);
    archiveRun(fixture);
    const incoming = path.join(fixture.libraryRoot, ".incoming", "unfinished");
    fs.mkdirSync(incoming);
    fs.writeFileSync(path.join(incoming, "partial"), "x\n");
    const verification = verifyVisualEvidenceLibrary({
      libraryRoot: fixture.libraryRoot,
    });
    assert.equal(verification.valid, false);
    assert.ok(
      verification.reasons.includes(
        "library has an unfinished .incoming publication",
      ),
    );
  });
  await t.test("claim", (t) => {
    const fixture = makeFixture(t);
    archiveRun(fixture);
    const claim = path.join(fixture.libraryRoot, ".claims", "stale.lock");
    fs.writeFileSync(claim, "stale\n");
    const verification = verifyVisualEvidenceLibrary({
      libraryRoot: fixture.libraryRoot,
    });
    assert.equal(verification.valid, false);
    assert.ok(
      verification.reasons.includes(
        "library has an active or stale publication claim",
      ),
    );
  });
});

test("an existing publication claim refuses a competing publisher", (t) => {
  const fixture = makeFixture(t);
  archiveRun(fixture);
  fixture.writeArtifact({ runId: SECOND_RUN_ID });
  const claim = path.join(
    fixture.libraryRoot,
    ".claims",
    "runs",
    "fixture-probe",
    `${SECOND_RUN_ID}.lock`,
  );
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, "owned\n");
  assert.throws(
    () => archiveRun(fixture, { runId: SECOND_RUN_ID }),
    /publication claim already exists/u,
  );
});

test("CLI parser rejects ambiguous numbers and unknown or incomplete commands", () => {
  assert.throws(
    () => parseVisualEvidenceArguments(["archive", "--exit-code", "1garbage"]),
    (error) =>
      error instanceof VisualEvidenceUsageError &&
      /base-10 integer/u.test(error.message),
  );
  assert.throws(
    () => parseVisualEvidenceArguments(["archive", "--mystery"]),
    /unknown option/u,
  );
  assert.throws(
    () =>
      runVisualEvidenceCommand(
        parseVisualEvidenceArguments(["archive", "--producer", "fixture"]),
      ),
    /--run-id is required/u,
  );
  const help = runVisualEvidenceCommand(
    parseVisualEvidenceArguments(["--help"]),
  );
  assert.equal(help.kind, "help");
  assert.match(help.text, /import-legacy/u);
});

test("CLI archive command preserves explicit roots and exact source verdict", (t) => {
  const fixture = makeFixture(t);
  const parsed = parseVisualEvidenceArguments([
    "archive",
    "--source-root",
    fixture.sourceRoot,
    "--library-root",
    fixture.libraryRoot,
    "--producer",
    "fixture-cli",
    "--run-id",
    RUN_ID,
    "--status",
    "PASS",
    "--exit-code",
    "0",
    "--artifact",
    relativeToSource(fixture, fixture.artifact),
    "--file",
    relativeToSource(fixture, fixture.image),
    "--command",
    "node fixture.mjs",
  ]);
  const command = runVisualEvidenceCommand(parsed, {
    now: fixture.now,
    provenanceCollector: fixture.provenanceCollector,
  });
  assert.equal(command.kind, "archive");
  assert.equal(command.result.manifest.producer, "fixture-cli");
  assert.equal(command.result.manifest.result.status, "PASS");
  assert.equal(command.result.manifest.result.exitCode, 0);
});

test("CLI archive dry-run performs all source checks without filesystem writes", (t) => {
  const fixture = makeFixture(t);
  const parsed = parseVisualEvidenceArguments([
    "archive",
    "--dry-run",
    "--source-root",
    fixture.sourceRoot,
    "--library-root",
    fixture.libraryRoot,
    "--producer",
    "fixture-cli",
    "--run-id",
    RUN_ID,
    "--status",
    "PASS",
    "--exit-code",
    "0",
    "--artifact",
    relativeToSource(fixture, fixture.artifact),
    "--file",
    relativeToSource(fixture, fixture.image),
  ]);
  const rejectWrite = () => {
    assert.fail("dry-run attempted a filesystem write");
  };
  const operations = forwardFs({
    appendFileSync: rejectWrite,
    copyFileSync: rejectWrite,
    linkSync: rejectWrite,
    mkdirSync: rejectWrite,
    renameSync: rejectWrite,
    rmSync: rejectWrite,
    unlinkSync: rejectWrite,
    writeFileSync: rejectWrite,
  });
  const command = runVisualEvidenceCommand(parsed, {
    operations,
    now: fixture.now,
    provenanceCollector: fixture.provenanceCollector,
  });
  assert.equal(command.kind, "dry-run");
  assert.equal(command.plan.schema, VISUAL_EVIDENCE_PLAN_SCHEMA);
  assert.equal(command.plan.ready, true);
  assert.equal(command.plan.writesPerformed, false);
  assert.equal(command.plan.publicationPath, `runs/fixture-cli/${RUN_ID}`);
  assert.equal(command.plan.files.length, 2);
  assert.equal(
    command.plan.files.find((entry) => entry.mediaType === "image/png").sha256,
    sha256(fs.readFileSync(fixture.image)),
  );
  assert.equal(fs.existsSync(fixture.libraryRoot), false);
});
