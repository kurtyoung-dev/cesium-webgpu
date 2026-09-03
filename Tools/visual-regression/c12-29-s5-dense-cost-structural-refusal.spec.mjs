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
//
// Part 3 (Q-117) covers a related but distinct gap in the SAME function:
// `resolvePublicationArtifact`'s refusal, when the manifest itself is simply
// ABSENT, used to be a bare "publication manifest is required" / a raw
// ENOENT — accurate but unhelpful. `git log --all` over both prerequisite
// probes' `output/` directories and `git log --all -S` over their evidence
// schema strings confirm neither manifest was EVER committed in this fork:
// they are external, content-addressed-library artifacts a live browser run
// plus `visual-evidence-library.mjs archive` must produce, which this never-
// executed-in-a-browser probe (`migration_doc/DEBUGGING_GUIDE.md`: "zero
// banked runs") has never had. The fix names the exact acquisition step in
// the refusal text instead of fabricating manifest content.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  C12_29_S5_DENSE_SCHEMA,
  exitCodeForC1229S5DenseStatus,
  foldC1229S5DenseCostGate,
  validateC1229S5DenseFinalArtifact,
  validateC1229S5DensePrerequisites,
} from "./lib/c12-29-s5-dense-cost-gate.mjs";
import {
  VisualEvidenceUsageError,
  parseVisualEvidenceArguments,
  runVisualEvidenceCommand,
} from "./visual-evidence-library.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
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

// ═════════════ Q-117: the missing-manifest refusal names its own fix ═══════

test("Q-117a: no --terrain-publication given names the exact acquisition step, not a bare 'is required'", async () => {
  const { loadPrerequisites } =
    await import("./probe-c12-29-s5-dense-cost.mjs");
  assert.throws(
    () =>
      loadPrerequisites({ terrainPublication: null, nasaPublication: null }),
    (error) => {
      assert.match(
        error.message,
        /^\[structural\] terrain publication manifest is required/,
      );
      // Names WHICH prerequisite probe produces the raw run, and the exact
      // archive command — not just that something is missing.
      assert.match(
        error.message,
        /probe-c12-29-s5-terrain-selection\.mjs/,
        "must name the prerequisite probe to run",
      );
      assert.match(
        error.message,
        /visual-evidence-library\.mjs archive --producer c12-29-s5-terrain-selection/,
        "must name the exact archive command, with the correct --producer",
      );
      assert.match(
        error.message,
        /--terrain-publication/,
        "must name the flag the resulting manifest feeds back into",
      );
      // B1 — every flag `validateCommandOptions` requires for `archive`
      // (Tools/visual-regression/visual-evidence-library.mjs:196-211): a
      // message naming only `--producer`/`--run-id`/`--artifact` passes 9/9
      // here yet gives an executor who runs it verbatim
      // `VisualEvidenceUsageError: --status is required for archive`, exit 2.
      for (const flag of [
        "--producer",
        "--run-id",
        "--status",
        "--exit-code",
        "--artifact",
      ]) {
        assert.ok(
          error.message.includes(flag),
          `acquisition step must name every required archive flag; missing ${flag}`,
        );
      }
      // The two flags B1 found omitted decide usability, not just presence:
      // certificationEligible = kind === "run" && status === "PASS" &&
      // exitCode === 0 (lib/visual-evidence-library.mjs:1204-1207), which
      // resolvePublicationArtifact requires. The message must give the
      // LITERAL values that satisfy it, not just the flag names.
      assert.match(error.message, /--status PASS\b/);
      assert.match(error.message, /--exit-code 0\b/);
      return true;
    },
  );
});

test("Q-117a MECHANIZED (B1): the exact acquisition command parses and validates against the tool's OWN argument parser, resolved and run with --dry-run", async () => {
  // Not a restatement of the assertions above: this extracts the command's
  // literal tokens straight out of the thrown message, substitutes ONLY the
  // two placeholders (<the run's runId>, <path to ... artifact>) with
  // concrete test values, and feeds the result through the real
  // `parseVisualEvidenceArguments` + `runVisualEvidenceCommand` (the exact
  // functions `visual-evidence-library.mjs`'s own CLI entry point calls).
  // Catches both classes of defect B1 found: a message that merely LOOKS
  // like a valid command (right words, wrong/missing flags) and one that IS
  // valid but does not run because a placeholder substitution was wrong.
  const { loadPrerequisites } =
    await import("./probe-c12-29-s5-dense-cost.mjs");
  let message;
  try {
    loadPrerequisites({ terrainPublication: null, nasaPublication: null });
    assert.fail("loadPrerequisites must throw when no manifest is given");
  } catch (error) {
    message = error.message;
  }

  const producer = /--producer (\S+)/.exec(message)?.[1];
  const status = /--status (\S+)/.exec(message)?.[1];
  const exitCodeText = /--exit-code (\S+)/.exec(message)?.[1];
  assert.equal(producer, "c12-29-s5-terrain-selection");
  assert.equal(status, "PASS");
  assert.equal(exitCodeText, "0");

  const root = await mkdtemp(
    path.join(tmpdir(), "c12-29-s5-dense-q117-dry-run-"),
  );
  try {
    const sourceRoot = path.join(root, "source");
    const outputDirectory = path.join(
      sourceRoot,
      "Tools",
      "visual-regression",
      "output",
      producer,
    );
    await mkdir(outputDirectory, { recursive: true });
    const artifactPath = path.join(outputDirectory, "fixture.json");
    const runId = randomUUID();
    await writeFile(
      artifactPath,
      JSON.stringify({
        schema: "fixture/v1",
        runId,
        status: "PASS",
        exitCode: 0,
        incomplete: false,
      }),
      "utf8",
    );
    const libraryRoot = path.join(root, "library");
    await mkdir(libraryRoot, { recursive: true });

    // The message's own step 2, with only its two placeholders resolved —
    // everything else (flag names, --status/--exit-code literals) is taken
    // from `producer`/`status`/`exitCodeText`, extracted above from the
    // ACTUAL thrown message, not re-typed from assumption.
    const argv = [
      "archive",
      "--source-root",
      sourceRoot,
      "--library-root",
      libraryRoot,
      "--producer",
      producer,
      "--run-id",
      runId,
      "--status",
      status,
      "--exit-code",
      exitCodeText,
      "--artifact",
      path.relative(sourceRoot, artifactPath),
      "--dry-run",
    ];
    const options = parseVisualEvidenceArguments(argv);
    const stubProvenance = () => ({
      capturedAt: new Date(0).toISOString(),
      worktreeRoot: sourceRoot,
      primaryRoot: sourceRoot,
      gitDirectory: path.join(sourceRoot, ".git"),
      gitCommonDirectory: path.join(sourceRoot, ".git"),
      head: "a".repeat(40),
      branch: "main",
      detached: false,
      dirty: false,
      statusByteLength: 0,
      statusSha256: "b".repeat(64),
      statusTokenCount: 0,
    });
    const result = runVisualEvidenceCommand(options, {
      provenanceCollector: stubProvenance,
    });
    assert.equal(result.kind, "dry-run");
    assert.equal(result.plan.ready, true);
    assert.equal(result.plan.result.status, "PASS");
    assert.equal(result.plan.result.exitCode, 0);
    assert.equal(result.plan.result.certificationEligible, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Q-117a MUTATION (B1): the pre-fix command (missing --status/--exit-code) is rejected by the real parser with exactly the error B1 reproduced", () => {
  // The mutant is the documented PRE-FIX shape itself (three of five flags),
  // run through the SAME real functions the test above uses — proving those
  // functions genuinely discriminate rather than accepting anything.
  const argv = [
    "archive",
    "--producer",
    "c12-29-s5-terrain-selection",
    "--run-id",
    randomUUID(),
    "--artifact",
    "irrelevant.json",
  ];
  const options = parseVisualEvidenceArguments(argv);
  assert.throws(
    () => runVisualEvidenceCommand(options, {}),
    (error) => {
      assert.ok(error instanceof VisualEvidenceUsageError);
      assert.equal(error.message, "--status is required for archive");
      return true;
    },
  );
});

test("Q-117a: a --nasa-publication path that does not exist on disk names ITS OWN missing path and acquisition step", async () => {
  const { loadPrerequisites } =
    await import("./probe-c12-29-s5-dense-cost.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "c12-29-s5-dense-q117-"));
  try {
    const terrainPublication = await writeFixturePublication(
      path.join(root, "terrain"),
      {
        producer: "c12-29-s5-terrain-selection",
        artifactSchema: "c12-29-s5-terrain-selection-evidence-v10",
      },
    );
    const absentNasaPath = path.join(root, "does-not-exist", "manifest.json");
    assert.throws(
      () =>
        loadPrerequisites({
          terrainPublication,
          nasaPublication: absentNasaPath,
        }),
      (error) => {
        assert.match(
          error.message,
          /^\[structural\] nasa publication manifest does not exist at/,
        );
        assert.ok(
          error.message.includes(absentNasaPath),
          "must name the EXACT path that was checked and is missing",
        );
        assert.match(error.message, /probe-c12-29-s5-svs-footprint\.mjs/);
        assert.match(
          error.message,
          /visual-evidence-library\.mjs archive --producer c12-29-s5-svs-footprint/,
        );
        assert.equal(
          error.cause?.code,
          "ENOENT",
          "the original ENOENT must be preserved as the cause, not swallowed",
        );
        // B1 — the SAME five-flag requirement applies to this failure mode
        // too; both call sites share `c1229S5DenseAcquisitionStep`, but this
        // asserts it independently rather than trusting that sharing.
        for (const flag of [
          "--producer",
          "--run-id",
          "--status",
          "--exit-code",
          "--artifact",
        ]) {
          assert.ok(error.message.includes(flag), `missing ${flag}`);
        }
        assert.match(error.message, /--status PASS\b/);
        assert.match(error.message, /--exit-code 0\b/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Q-117b: a genuinely eligible publication still resolves normally — the richer refusal text does not touch the success path", async () => {
  const { loadPrerequisites } =
    await import("./probe-c12-29-s5-dense-cost.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "c12-29-s5-dense-q117-pass-"));
  try {
    const terrainPublication = await writeFixturePublication(
      path.join(root, "terrain"),
      {
        producer: "c12-29-s5-terrain-selection",
        artifactSchema: "c12-29-s5-terrain-selection-evidence-v10",
      },
    );
    const nasaPublication = await writeFixturePublication(
      path.join(root, "nasa"),
      {
        producer: "c12-29-s5-svs-footprint",
        artifactSchema: "c12-29-s5-svs-5073-footprint-evidence-v5",
      },
    );
    const prerequisites = loadPrerequisites({
      terrainPublication,
      nasaPublication,
    });
    assert.equal(validateC1229S5DensePrerequisites(prerequisites).valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Q-117 MUTATION (CLAUDE.md Principle 10). Imports a MUTATED copy of the
// probe from a directory UNDER `os.tmpdir()` (N8 — not the tracked
// `Tools/visual-regression/` directory an interrupted run could leave litter
// in). The probe's bare `import { chromium } from "playwright"` and its
// three `./lib/...` relative imports would not otherwise resolve from a temp
// directory outside this repository, so all four are rewritten to absolute
// `file://` URLs (the bare specifier to this repo's OWN `node_modules`,
// junction-followed) before the mutant is written — verified independently:
// the rewritten-but-unmutated text imports cleanly from `os.tmpdir()`, so a
// resolution failure below is a real defect, not a rewrite artifact. Removed
// in `finally` regardless of outcome. Reverts the acquisition-step text back
// to the pre-fix bare message and proves this suite's own assertions above
// are not vacuously true — they fail against the REAL pre-fix code, executed.

const repositoryRoot = path.resolve(here, "..", "..");

/**
 * Rewrites `probe-c12-29-s5-dense-cost.mjs`'s bare `playwright` import and its
 * three `./lib/...` relative imports to absolute `file://` URLs, so a copy of
 * the module can be imported from anywhere — specifically `os.tmpdir()`,
 * outside this repository's own module-resolution ancestry (N8).
 *
 * @param {string} source Original file text (LF-normalized).
 * @returns {string} Rewritten text; import behaviour unchanged, only where
 *   each specifier resolves from.
 */
function rehomeDenseCostProbeImports(source) {
  const playwrightUrl = pathToFileURL(
    path.join(repositoryRoot, "node_modules/playwright/index.mjs"),
  ).href;
  return source
    .replace(
      'import { chromium } from "playwright";',
      `import { chromium } from ${JSON.stringify(playwrightUrl)};`,
    )
    .replace(
      '} from "./lib/c12-29-s5-dense-cost-gate.mjs";',
      `} from ${JSON.stringify(
        pathToFileURL(
          path.join(
            repositoryRoot,
            "Tools/visual-regression/lib/c12-29-s5-dense-cost-gate.mjs",
          ),
        ).href,
      )};`,
    )
    .replace(
      '} from "./lib/build-source-identity.mjs";',
      `} from ${JSON.stringify(
        pathToFileURL(
          path.join(
            repositoryRoot,
            "Tools/visual-regression/lib/build-source-identity.mjs",
          ),
        ).href,
      )};`,
    )
    .replace(
      'import { terminateC11168ChildTree } from "./lib/c11-168-direct-model-ablation.mjs";',
      `import { terminateC11168ChildTree } from ${JSON.stringify(
        pathToFileURL(
          path.join(
            repositoryRoot,
            "Tools/visual-regression/lib/c11-168-direct-model-ablation.mjs",
          ),
        ).href,
      )};`,
    );
}

test("Q-117 MUTATION: reverting the acquisition-step text reproduces the pre-fix bare message", async () => {
  const probePath = path.join(here, "probe-c12-29-s5-dense-cost.mjs");
  const original = (await readFile(probePath, "utf8")).split("\r\n").join("\n");
  const rehomed = rehomeDenseCostProbeImports(original);
  assert.notEqual(
    rehomed,
    original,
    "the import-rehoming did not change probe-c12-29-s5-dense-cost.mjs — its target text has moved",
  );
  const mutated = rehomed.replace(
    "`[structural] ${expected.kind} publication manifest is required — ` +\n" +
      "        `it is an external, never-generated-in-this-tree artifact (Q-117), ` +\n" +
      "        `${c1229S5DenseAcquisitionStep(expected)}`,",
    "`[structural] ${expected.kind} publication manifest is required`,",
  );
  assert.notEqual(
    mutated,
    rehomed,
    "the acquisition-step mutation did not change probe-c12-29-s5-dense-cost.mjs — its target text has moved",
  );
  const tmpDir = await mkdtemp(
    path.join(tmpdir(), "c12-29-s5-dense-q117-mutant-"),
  );
  const mutantPath = path.join(tmpDir, "mutant.mjs");
  await writeFile(mutantPath, mutated, "utf8");
  try {
    const mutant = await import(pathToFileURL(mutantPath).href);
    let thrown = null;
    try {
      mutant.loadPrerequisites({
        terrainPublication: null,
        nasaPublication: null,
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(
      thrown,
      "the mutant must still refuse — this proves ONLY the message shrank",
    );
    assert.equal(
      thrown.message,
      "[structural] terrain publication manifest is required",
      "the mutant must reproduce the exact pre-fix bare message",
    );
    // And THIS suite's own acquisition-step assertions correctly reject it.
    assert.throws(() => {
      assert.match(thrown.message, /probe-c12-29-s5-terrain-selection\.mjs/);
    }, assert.AssertionError);
    assert.throws(() => {
      assert.match(thrown.message, /visual-evidence-library\.mjs archive/);
    }, assert.AssertionError);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
