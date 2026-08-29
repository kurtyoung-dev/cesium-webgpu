// @purpose Q-116 — regression coverage for the replacement-device S5 probe's
// preflight refusal path: an invalid source-identity preflight used to
// `throw` before any RUNNING lock existed, landing in the probe's generic
// catch-all with `ownership` still `undefined` — whose
// `if (!ownership || ...) throw error;` re-threw the raw error uncaught, so
// the run crashed with NO published artifact and nothing to release. Model:
// the dense-cost probe's Batch-1279 contract
// (`c12-29-s5-dense-cost-structural-refusal.spec.mjs` and the probe's own
// refusal path) — a structural refusal must leave a written artifact.
// Replacement-device's lock is architecturally different (it can only be
// acquired FOR an already-valid preflight — see the comment on
// `collectProvenanceStart` in the probe itself), so its fix is a parallel,
// lock-free write path rather than "acquire the lock, then fail inside it"
// the way dense-cost does; that difference is why this suite proves "no lock
// was ever taken" rather than "the taken lock was released".
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/c12-29-s5-replacement-device-preflight-refusal.spec.mjs
//
// Part 1 unit-tests the pure artifact builder against a REAL drifted source
// map (the exact fixture recipe `build-source-identity.spec.mjs:43-59` uses)
// run through the real `inspectBuildSourceIdentity` — no browser, no server,
// no real build. Part 2 drives `writeC1229S5ReplacementPreflightRefusal`
// against a real temp directory. Part 3 drives the real
// `runC1229S5ReplacementDeviceProbe` orchestration end to end, with
// `collectProvenanceStart` and `beginC1229S5ReplacementEvidenceRun`
// overridden via their existing (this fix's) test-only injection seams — the
// same pattern as the pre-existing `launchBrowser` seam — so the refuse-vs-
// proceed control flow this fix changes is exercised deterministically,
// without a live server, browser, or built bundle. Part 4 is the mutation
// proof.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspectBuildSourceIdentity } from "./lib/build-source-identity.mjs";
import {
  exitCodeForC1229S5ReplacementStatus,
  validateC1229S5ReplacementPreflightRefusalArtifact,
} from "./lib/c12-29-s5-replacement-device-gate.mjs";
import {
  buildC1229S5ReplacementPreflightRefusalArtifact,
  createC1229S5ReplacementArtifactPaths,
  runC1229S5ReplacementDeviceProbe,
  writeC1229S5ReplacementPreflightRefusal,
} from "./probe-c12-29-s5-replacement-device.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = path.join(here, "probe-c12-29-s5-replacement-device.mjs");
const PROBE_REL =
  "Tools/visual-regression/probe-c12-29-s5-replacement-device.mjs";

// ─────────────────── shared fixture: the drifted source map ────────────────
//
// Exactly the recipe `build-source-identity.spec.mjs:43-59` (`makeFixture`)
// uses: a `.js.map` whose `sourcesContent` embeds different bytes than what
// is currently on disk. `inspectBuildSourceIdentity` is the REAL primitive
// the replacement-device probe's `collectProvenanceStart` calls (imported,
// not re-implemented), so this is the actual detection path, not a stand-in.
async function makeDriftedSourceMapFixture(root) {
  const sourcePath = path.join(root, "Fixture.js");
  await writeFile(sourcePath, "export const value = 2;\n", "utf8"); // current on disk
  const mapPath = path.join(root, "index.js.map");
  await writeFile(
    mapPath,
    JSON.stringify({
      version: 3,
      sources: ["./Fixture.js"],
      sourcesContent: ["export const value = 1;\n"], // what the "build" embedded
    }),
    "utf8",
  );
  return inspectBuildSourceIdentity({
    sourceMapPath: mapPath,
    sourceFiles: [sourcePath],
  });
}

async function makeMatchingSourceMapFixture(root) {
  const sourcePath = path.join(root, "Fixture.js");
  const text = "export const value = 1;\n";
  await writeFile(sourcePath, text, "utf8");
  const mapPath = path.join(root, "index.js.map");
  await writeFile(
    mapPath,
    JSON.stringify({
      version: 3,
      sources: ["./Fixture.js"],
      sourcesContent: [text],
    }),
    "utf8",
  );
  return inspectBuildSourceIdentity({
    sourceMapPath: mapPath,
    sourceFiles: [sourcePath],
  });
}

/** Minimal provenance shape `buildC1229S5ReplacementPreflightRefusalArtifact` reads. */
function fakeProvenance(buildSourceIdentity, overrides = {}) {
  return {
    gitHead: "deadbeef",
    preflightSha256: "0".repeat(64),
    buildSourceIdentity,
    policyBoundary: { closed: true },
    sourceBoundaryStart: { allExact: true },
    buildEntryMatchesServed: true,
    servedMatchesLocal: true,
    ...overrides,
  };
}

// ═══════════════ 1. buildC1229S5ReplacementPreflightRefusalArtifact ═════════

test("Q-116a: a fabricated drifted source map produces ok:false, and the artifact carries its identity deltas", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "q116-drift-"));
  try {
    const drifted = await makeDriftedSourceMapFixture(root);
    assert.equal(drifted.ok, false, "the fixture must actually be drifted");
    assert.equal(drifted.entries.length, 1);
    assert.equal(drifted.entries[0].exact, false);
    assert.notEqual(
      drifted.entries[0].currentSha256,
      drifted.entries[0].embeddedSha256,
    );

    const runId = randomUUID();
    const valid = {
      ok: false,
      reasons: [
        "preflight provenance prerequisites are not exact and eligible",
      ],
    };
    const artifact = buildC1229S5ReplacementPreflightRefusalArtifact(
      runId,
      fakeProvenance(drifted),
      valid,
    );

    assert.equal(
      artifact.schema,
      "c12-29-s5-replacement-device-preflight-refusal-v1",
    );
    assert.equal(artifact.runId, runId);
    assert.equal(artifact.status, "STRUCTURAL");
    assert.equal(
      artifact.exitCode,
      exitCodeForC1229S5ReplacementStatus("STRUCTURAL"),
    );
    assert.equal(artifact.exitCode, 3);
    assert.deepEqual(artifact.reasons, valid.reasons);
    // The "build/tree tuples": current-vs-embedded identity per source file.
    assert.match(artifact.buildSourceIdentity.entries[0].file, /Fixture\.js$/);
    assert.equal(artifact.buildSourceIdentity.entries[0].exact, false);
    assert.equal(artifact.buildSourceIdentity.ok, false);
    assert.match(
      new Date(artifact.refusedAt).toISOString(),
      /^\d{4}-\d{2}-\d{2}T/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Q-116a: a matching source map (positive case) round-trips through the same builder as ok:true", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "q116-match-"));
  try {
    const matching = await makeMatchingSourceMapFixture(root);
    assert.equal(matching.ok, true);
    // The artifact builder itself does not gate on ok:true/false — the
    // CALLER (runC1229S5ReplacementDeviceProbe) only invokes it once
    // `collected.valid.ok` is false. This just proves the builder does not
    // silently coerce a passing identity into a failure shape either.
    const runId = randomUUID();
    const artifact = buildC1229S5ReplacementPreflightRefusalArtifact(
      runId,
      fakeProvenance(matching),
      { ok: false, reasons: ["unrelated prerequisite failed"] },
    );
    assert.equal(artifact.buildSourceIdentity.ok, true);
    assert.equal(artifact.reasons[0], "unrelated prerequisite failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ═══════════════ 2. writeC1229S5ReplacementPreflightRefusal ═════════════════

test("Q-116b: the refusal artifact + receipt are written, and NO lock/running/latest files exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "q116-write-"));
  try {
    const runId = randomUUID();
    const paths = createC1229S5ReplacementArtifactPaths(runId, root);
    const artifact = buildC1229S5ReplacementPreflightRefusalArtifact(
      runId,
      fakeProvenance({ ok: false, entries: [], reasons: ["drift"] }),
      { ok: false, reasons: ["drift"] },
    );

    const publication = writeC1229S5ReplacementPreflightRefusal(
      paths,
      artifact,
    );

    assert.equal(
      fs.existsSync(paths.refusal),
      true,
      "artifact must be written",
    );
    assert.equal(
      fs.existsSync(paths.refusalReceipt),
      true,
      "receipt must be written",
    );
    const onDisk = JSON.parse(fs.readFileSync(paths.refusal, "utf8"));
    assert.deepEqual(onDisk, artifact);
    const receipt = JSON.parse(fs.readFileSync(paths.refusalReceipt, "utf8"));
    assert.equal(receipt.runId, runId);
    assert.equal(receipt.status, "STRUCTURAL");
    assert.equal(receipt.archiveSha256, publication.sha256);

    // The actual Q-116 claim: no RUNNING lock was ever acquired for this run,
    // so there is nothing to release and nothing left dangling.
    assert.equal(fs.existsSync(paths.lock), false);
    assert.equal(fs.existsSync(paths.running), false);
    assert.equal(fs.existsSync(paths.latest), false);
    assert.equal(fs.existsSync(paths.finalizing), false);

    // Idempotent retry with the SAME runId/bytes (a re-run against the same
    // still-broken tree) must not throw — write-once-exact, not write-once.
    const again = writeC1229S5ReplacementPreflightRefusal(paths, artifact);
    assert.equal(again.sha256, publication.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Q-116b (N4): a malformed artifact is refused BEFORE any write, and the real validator rejects it independently", async () => {
  const runId = randomUUID();
  const goodArtifact = buildC1229S5ReplacementPreflightRefusalArtifact(
    runId,
    fakeProvenance({ ok: false, entries: [], reasons: ["drift"] }),
    { ok: false, reasons: ["drift"] },
  );
  assert.equal(
    validateC1229S5ReplacementPreflightRefusalArtifact(goodArtifact).ok,
    true,
    "the builder's own output must validate",
  );

  const root = await mkdtemp(path.join(tmpdir(), "q116-n4-"));
  try {
    const paths = createC1229S5ReplacementArtifactPaths(runId, root);
    const malformed = { ...goodArtifact, status: "PASS" }; // not STRUCTURAL
    const validity =
      validateC1229S5ReplacementPreflightRefusalArtifact(malformed);
    assert.equal(validity.ok, false);
    assert.ok(
      validity.reasons.some((reason) =>
        reason.includes("status must be STRUCTURAL"),
      ),
    );
    assert.throws(
      () => writeC1229S5ReplacementPreflightRefusal(paths, malformed),
      /refusing invalid preflight refusal artifact/,
    );
    assert.equal(
      fs.existsSync(paths.refusal),
      false,
      "a malformed artifact must never reach disk",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ═══════════════ 3. runC1229S5ReplacementDeviceProbe orchestration ═════════

test("Q-116c: an invalid preflight writes an artifact and NEVER calls launchBrowser", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "q116-orch-refuse-"));
  try {
    const runId = randomUUID();
    const driftedRoot = await mkdtemp(
      path.join(tmpdir(), "q116-orch-drift-src-"),
    );
    let launchCalled = false;
    try {
      const drifted = await makeDriftedSourceMapFixture(driftedRoot);
      const result = await runC1229S5ReplacementDeviceProbe({
        runId,
        outputDirectory: root,
        collectProvenanceStart: async () => ({
          provenance: fakeProvenance(drifted),
          valid: {
            ok: false,
            reasons: [
              "preflight provenance prerequisites are not exact and eligible",
            ],
          },
        }),
        launchBrowser: async () => {
          launchCalled = true;
          throw new Error(
            "launchBrowser must never be called on a refused preflight",
          );
        },
      });

      assert.equal(
        launchCalled,
        false,
        "the refusal must short-circuit before any launch attempt",
      );
      assert.equal(result.refused, true);
      assert.equal(result.artifact.status, "STRUCTURAL");
      assert.equal(result.artifact.exitCode, 3);

      const paths = createC1229S5ReplacementArtifactPaths(runId, root);
      assert.equal(fs.existsSync(paths.refusal), true);
      assert.equal(fs.existsSync(paths.refusalReceipt), true);
      assert.equal(
        fs.existsSync(paths.lock),
        false,
        "no lock may exist for a refused preflight",
      );
      assert.equal(fs.existsSync(paths.running), false);
      assert.equal(fs.existsSync(paths.latest), false);
    } finally {
      await rm(driftedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Q-116c: a matching preflight is NOT refused and reaches the launchBrowser call (stubbed)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "q116-orch-pass-"));
  try {
    const runId = randomUUID();
    let launchCalled = false;
    let beginCalled = false;
    const outcome = await runC1229S5ReplacementDeviceProbe({
      runId,
      outputDirectory: root,
      collectProvenanceStart: async () => ({
        provenance: fakeProvenance({ ok: true, entries: [], reasons: [] }),
        valid: { ok: true, reasons: [] },
      }),
      // Narrow stand-in for the real lock-acquisition machinery (which needs
      // a fully realistic provenance object to satisfy its own, separately
      // covered, CAS invariants — orthogonal to what this test asserts: that
      // a PASSING preflight is not refused and control reaches the launch
      // call at all).
      beginC1229S5ReplacementEvidenceRun: () => {
        beginCalled = true;
        return {
          runId,
          lockBytes: Buffer.from("stub-lock"),
          runningBytes: Buffer.from("stub-running"),
          preflightSha256: "stub",
        };
      },
      launchBrowser: async () => {
        launchCalled = true;
        throw new Error(
          "STUB: launch reached; intentionally aborting the rest of the run",
        );
      },
    }).catch((error) => ({ caughtRejection: error }));

    assert.equal(
      beginCalled,
      true,
      "a passing preflight must reach beginC1229S5ReplacementEvidenceRun",
    );
    assert.equal(
      launchCalled,
      true,
      "a passing preflight must reach launchBrowser",
    );
    // What happens AFTER the stubbed launch throw (the generic catch-all's
    // own artifact publication) is orthogonal to this fix and not asserted
    // here; `outcome` is inspected only to prove the call did not hang.
    assert.ok(outcome !== undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ═══════════════════════════ 4. MUTATION proof ══════════════════════════════
//
// Imports a MUTATED copy of the probe from a directory under `os.tmpdir()`
// (N8, station-3 review — not the tracked `Tools/visual-regression/`
// directory, where an interrupted run could leave litter). The probe's bare
// `import { chromium } from "playwright"` and its three `./lib/...` relative
// imports would not otherwise resolve from outside this repository, so both
// are rewritten to absolute `file://` URLs (the bare specifier to this
// repo's OWN `node_modules`, junction-followed) before the mutant is
// written. Removed in `finally` regardless of outcome.

const repositoryRoot = path.resolve(here, "..", "..");

/**
 * Rewrites `probe-c12-29-s5-replacement-device.mjs`'s bare `playwright`
 * import and its three `./lib/...` relative imports to absolute `file://`
 * URLs, so a copy can be imported from anywhere (N8).
 *
 * @param {string} source Original file text (LF-normalized).
 * @returns {string} Rewritten text; import behaviour unchanged, only where
 *   each specifier resolves from.
 */
function rehomeReplacementDeviceProbeImports(source) {
  const playwrightUrl = pathToFileURL(
    path.join(repositoryRoot, "node_modules/playwright/index.mjs"),
  ).href;
  const libUrl = (name) =>
    JSON.stringify(
      pathToFileURL(
        path.join(repositoryRoot, "Tools/visual-regression/lib", name),
      ).href,
    );
  const toolsLibUrl = (name) =>
    JSON.stringify(
      pathToFileURL(path.join(repositoryRoot, "Tools/lib", name)).href,
    );
  return source
    .replace(
      'import { chromium } from "playwright";',
      `import { chromium } from ${JSON.stringify(playwrightUrl)};`,
    )
    .replace(
      '} from "./lib/c12-29-s5-replacement-device-gate.mjs";',
      `} from ${libUrl("c12-29-s5-replacement-device-gate.mjs")};`,
    )
    .replace(
      '} from "./lib/c12-29-s5-replacement-device-capture.mjs";',
      `} from ${libUrl("c12-29-s5-replacement-device-capture.mjs")};`,
    )
    .replace(
      '} from "./lib/build-source-identity.mjs";',
      `} from ${libUrl("build-source-identity.mjs")};`,
    )
    .replace(
      '} from "../lib/webgpu-error-gate.mjs";',
      `} from ${toolsLibUrl("webgpu-error-gate.mjs")};`,
    );
}

async function importMutatedProbe(mutate, label) {
  const original = (await readFile(PROBE_PATH, "utf8"))
    .split("\r\n")
    .join("\n");
  const rehomed = rehomeReplacementDeviceProbeImports(original);
  assert.notEqual(
    rehomed,
    original,
    `the import-rehoming did not change ${PROBE_REL} — its target text has moved`,
  );
  const mutated = mutate(rehomed);
  assert.notEqual(
    mutated,
    rehomed,
    `the ${label} mutation did not change ${PROBE_REL} — its target text has moved`,
  );
  const tmpDir = await mkdtemp(
    path.join(tmpdir(), "c12-29-s5-replacement-q116-mutant-"),
  );
  const mutantPath = path.join(tmpDir, "mutant.mjs");
  await writeFile(mutantPath, mutated, "utf8");
  try {
    return await import(pathToFileURL(mutantPath).href);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("Q-116 MUTATION: reverting the refuse-branch to inert readmits the pre-fix uncaught-throw defect", async () => {
  const mutant = await importMutatedProbe(
    (src) =>
      src.replace(
        "if (!collected.valid.ok) {",
        "if (false && !collected.valid.ok) {",
      ),
    "refusal-branch inertness",
  );

  const root = await mkdtemp(path.join(tmpdir(), "q116-mutant-"));
  try {
    const runId = randomUUID();
    let launchCalled = false;
    // Under the mutant, an invalid preflight no longer short-circuits: it
    // falls through toward `beginC1229S5ReplacementEvidenceRun`, which (with
    // no valid provenance) throws the SAME uncaught-with-no-artifact defect
    // this fix closed for the real preflight-invalid path. The stub below
    // stands in for the real lock function so the assertion is specifically
    // "did the refusal branch fire", not "does the unrelated lock machinery
    // also happen to throw for an unrelated reason".
    let rejected = null;
    try {
      await mutant.runC1229S5ReplacementDeviceProbe({
        runId,
        outputDirectory: root,
        collectProvenanceStart: async () => ({
          provenance: fakeProvenance({
            ok: false,
            entries: [],
            reasons: ["drift"],
          }),
          valid: { ok: false, reasons: ["drift"] },
        }),
        beginC1229S5ReplacementEvidenceRun: () => {
          throw new Error(
            "simulated: begin refuses an invalid preflight, as it must",
          );
        },
        launchBrowser: async () => {
          launchCalled = true;
          throw new Error("must not be reached");
        },
      });
    } catch (error) {
      rejected = error;
    }

    assert.equal(launchCalled, false);
    assert.ok(
      rejected,
      "the mutant must reproduce an uncaught rejection instead of a written refusal artifact",
    );
    const paths = createC1229S5ReplacementArtifactPaths(runId, root);
    assert.equal(
      fs.existsSync(paths.refusal),
      false,
      "the mutant must NOT have written a refusal artifact — this is the pre-fix defect, reproduced",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
