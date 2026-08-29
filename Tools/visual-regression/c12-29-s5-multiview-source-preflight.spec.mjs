// @purpose Q-99 — regression coverage for the multiview probe's new
// pre-launch build-source-identity preflight: `evaluateC1229S5MultiviewSourcePreflight`
// in isolation, and the real `runC1229S5MultiviewProbe` proving no browser
// is launched and a structured ERROR artifact publishes (lock released) when
// the check fails before `browser = await launchBrowser(...)` runs.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/c12-29-s5-multiview-source-preflight.spec.mjs
//
// No browser is ever launched by this spec — `launchBrowser` is always
// replaced with a poisoned stub that throws if called, and every assertion
// about "no browser" is checked against whether that stub ran, not merely
// against the reported status. Part 2 briefly writes a fixture
// `Build/CesiumUnminified/index.js.map` in THIS clone's own (gitignored,
// untracked) Build/ output directory to exercise the real module-level
// paths `collectC1229S5MultiviewProvenanceSnapshot` reads, and removes it
// (and the directory, if this test created it) in a `finally`.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateC1229S5MultiviewSourcePreflight } from "./probe-c12-29-s5-multiview.mjs";
import { C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES } from "./lib/c12-29-s5-multiview-gate.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * Writes `mapContent` to this clone's own (gitignored, untracked)
 * `Build/CesiumUnminified/index.js.map` — the real, module-level path
 * `collectC1229S5MultiviewProvenanceSnapshot` reads, which is not
 * injectable. Returns a `restore()` function that undoes exactly what this
 * call created (the file, and `Build/CesiumUnminified`/`Build` themselves if
 * this call is what created them) — call it in a `finally`.
 *
 * @param {object} mapContent
 * @returns {() => void} restore
 */
function stageFixtureBuildSourceMap(mapContent) {
  const buildRoot = path.join(repositoryRoot, "Build");
  const buildDirectory = path.join(buildRoot, "CesiumUnminified");
  const mapPath = path.join(buildDirectory, "index.js.map");
  const buildRootPreexisted = fs.existsSync(buildRoot);
  const buildDirectoryPreexisted = fs.existsSync(buildDirectory);
  const mapPreexisted = fs.existsSync(mapPath);
  const savedMapBytes = mapPreexisted ? fs.readFileSync(mapPath) : null;
  fs.mkdirSync(buildDirectory, { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify(mapContent));
  return function restore() {
    if (mapPreexisted) {
      fs.writeFileSync(mapPath, savedMapBytes);
    } else {
      fs.rmSync(mapPath, { force: true });
    }
    if (!buildDirectoryPreexisted) {
      fs.rmSync(buildDirectory, { recursive: true, force: true });
    }
    if (!buildRootPreexisted) {
      // Leave no trace: this call may be the one that created `Build/`
      // itself (a fresh, never-built clone has none), not just the
      // `CesiumUnminified` child.
      fs.rmSync(buildRoot, { recursive: true, force: true });
    }
  };
}

/**
 * Builds a source map whose `sources`/`sourcesContent` embed the CURRENT
 * real bytes of every file `C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES` names —
 * the matching-`sourcesContent` fixture recipe from
 * `build-source-identity.spec.mjs:43-59` (a source's built content equals
 * its live content), applied to the real file set this probe checks, so
 * `inspectBuildSourceIdentity` reports `ok:true` for real, not by
 * construction of a synthetic file list.
 */
function buildMatchingSourceMap() {
  const buildDirectory = path.join(repositoryRoot, "Build", "CesiumUnminified");
  const sources = [];
  const sourcesContent = [];
  for (const relativeFile of C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES) {
    const absoluteFile = path.join(repositoryRoot, relativeFile);
    const text = fs.readFileSync(absoluteFile, "utf8");
    sources.push(
      path.relative(buildDirectory, absoluteFile).replaceAll("\\", "/"),
    );
    sourcesContent.push(text);
  }
  return { version: 3, sources, sourcesContent };
}

test("evaluateC1229S5MultiviewSourcePreflight: ok:true passes through with no reasons", () => {
  const result = evaluateC1229S5MultiviewSourcePreflight({
    ok: true,
    reasons: [],
    entries: [{ file: "x", exact: true }],
  });
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("evaluateC1229S5MultiviewSourcePreflight: ok:false carries the real reasons through", () => {
  const result = evaluateC1229S5MultiviewSourcePreflight({
    ok: false,
    reasons: [
      "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts: current source bytes differ from built sourcesContent",
    ],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, [
    "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts: current source bytes differ from built sourcesContent",
  ]);
});

// Mutation check (CLAUDE.md Principle 10): an inert version of this helper
// might just check `Boolean(buildSourceIdentity)` (truthy object) rather
// than reading `.ok`, which would wrongly pass a well-formed-but-failed
// snapshot. Cover exactly that shape.
test("mutant check: a well-formed but ok:false object is still refused, not passed through on shape alone", () => {
  const result = evaluateC1229S5MultiviewSourcePreflight({
    ok: false,
    reasons: [
      "some/file.ts: current source bytes differ from built sourcesContent",
    ],
    entries: [],
    sourceMapPath: "/repo/Build/CesiumUnminified/index.js.map",
    sourceMapByteLength: 12345,
    sourceMapSha256: "a".repeat(64),
  });
  assert.equal(result.ok, false);
});

test("evaluateC1229S5MultiviewSourcePreflight: missing/malformed input refuses with a safe fallback reason instead of throwing", () => {
  for (const malformed of [
    null,
    undefined,
    {},
    { ok: false },
    { ok: false, reasons: "not-an-array" },
  ]) {
    const result = evaluateC1229S5MultiviewSourcePreflight(malformed);
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
  }
});

test("runC1229S5MultiviewProbe: refuses before launching a browser when the build is absent, publishes a structured ERROR artifact, and releases the lock", async () => {
  // Post-review fix: the "build absent" scenario must be INJECTED, not read
  // from the ambient tree. The original version relied on THIS clone never
  // having been built (no real Build/CesiumUnminified/index.js.map) — a
  // harness-supplied-context defect (repo feedback memory: it certifies the
  // clone, not the artifact). On a tree that HAS been built (main, freshly
  // rebuilt before landing), the same assertion failed for the wrong reason
  // — `launchCalled` came back `true` because the real ambient build existed
  // and matched. Fixed by pointing `runC1229S5MultiviewProbe` at an
  // explicitly absent `buildSourceMapPath` — the narrow injection seam added
  // to `probe-c12-29-s5-multiview.mjs` for this fix (defaults to the real
  // path for every caller that does not override it) — so this test is now
  // RED-capable and GREEN on any tree, built or not.
  //
  // To prove the injection, not a lucky absence, controls the outcome: a
  // DECOY real build — a fully matching, would-preflight-PASS source map —
  // is staged at the REAL ambient `Build/CesiumUnminified/index.js.map` path
  // before the probe runs (removed after), using the same
  // `stageFixtureBuildSourceMap`/`buildMatchingSourceMap` this file already
  // uses for the positive-path test below. The probe is told to read a
  // DIFFERENT, never-created path instead, and must still take the
  // absent-build branch — proving it is not reading the decoy.
  const { runC1229S5MultiviewProbe } =
    await import("./probe-c12-29-s5-multiview.mjs");
  const restoreAmbientDecoy = stageFixtureBuildSourceMap(
    buildMatchingSourceMap(),
  );
  const root = await mkdtemp(
    path.join(tmpdir(), "multiview-preflight-absent-"),
  );
  // Deliberately never created — a fresh temp directory the injected path
  // points into, distinct from both `root` itself and the real ambient
  // `Build/` the decoy above just populated.
  const injectedAbsentSourceMapPath = path.join(
    root,
    "no-build-here",
    "index.js.map",
  );
  let launchCalled = false;
  try {
    assert.equal(
      fs.existsSync(injectedAbsentSourceMapPath),
      false,
      "the injected path must genuinely be absent for this test to mean anything",
    );

    const result = await runC1229S5MultiviewProbe({
      runId: randomUUID(),
      outputDirectory: root,
      buildSourceMapPath: injectedAbsentSourceMapPath,
      launchBrowser: async () => {
        launchCalled = true;
        throw new Error("launchBrowser must not be called");
      },
    });

    assert.equal(launchCalled, false);
    assert.equal(result.artifact.status, "ERROR");
    assert.equal(result.artifact.exitCode, 2);
    // Names the INJECTED path specifically — proves the injection drove the
    // outcome, not a coincidental read of the ambient (decoy-populated) one.
    assert.match(
      result.artifact.diagnostics.errorMessage,
      /no-build-here[\\/]index\.js\.map/,
    );
    assert.equal(fs.existsSync(path.join(root, "active.lock.json")), false);
  } finally {
    restoreAmbientDecoy();
    await rm(root, { recursive: true, force: true });
  }
});

test("runC1229S5MultiviewProbe: refuses before launching a browser when the build source map disagrees with current source, publishes a structured ERROR artifact tagged 'preflight', and releases the lock", async () => {
  // Empty sources/sourcesContent: EVERY file `C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES`
  // lists reports "source is absent from build source map" — deterministic
  // ok:false without needing to match every real file's live content.
  const restore = stageFixtureBuildSourceMap({
    version: 3,
    sources: [],
    sourcesContent: [],
  });

  const { runC1229S5MultiviewProbe } =
    await import("./probe-c12-29-s5-multiview.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "multiview-preflight-drift-"));
  let launchCalled = false;
  try {
    const result = await runC1229S5MultiviewProbe({
      runId: randomUUID(),
      outputDirectory: root,
      launchBrowser: async () => {
        launchCalled = true;
        throw new Error("launchBrowser must not be called");
      },
    });

    assert.equal(launchCalled, false);
    assert.equal(result.artifact.status, "ERROR");
    assert.equal(result.artifact.exitCode, 2);
    assert.equal(result.artifact.diagnostics.stage, "preflight");
    assert.match(
      result.artifact.diagnostics.errorMessage,
      /\[structural\] build source preflight failed/,
    );
    assert.equal(fs.existsSync(path.join(root, "active.lock.json")), false);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("FU-2: runC1229S5MultiviewProbe: a MATCHING build source map lets the probe reach launchBrowser (positive path)", async () => {
  // Q-99's original spec asserted only `launchCalled === false` in both
  // e2e cases — an always-refuse mutant (`if (true) throw ...` in place of
  // `if (!sourcePreflight.ok) throw ...`) would satisfy every assertion in
  // this file and permanently brick multiview with a green suite. This test
  // closes that gap: a source map whose `sourcesContent` matches every real
  // file `C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES` names must let the probe
  // PAST the preflight and reach `launchBrowser`.
  const restore = stageFixtureBuildSourceMap(buildMatchingSourceMap());

  const { runC1229S5MultiviewProbe } =
    await import("./probe-c12-29-s5-multiview.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "multiview-preflight-match-"));
  let launchCalled = false;
  try {
    // No real browser is launched: this stub records the call, then throws
    // immediately to abort before any Playwright/Edge automation — proving
    // reachability, not driving a session (HARD RULE: no browsers). Verified
    // empirically (not assumed): `runC1229S5MultiviewProbe` resolves
    // normally here rather than rejecting — `browser` is still `undefined`
    // when `launchBrowser` throws, so the same catch-all that handles the
    // "build absent"/"drift" cases above takes over and publishes an ERROR
    // artifact (`stage: "node"`, since this throw carries no
    // `c1229MultiviewDiagnostic`) instead of propagating the stub's error.
    const result = await runC1229S5MultiviewProbe({
      runId: randomUUID(),
      outputDirectory: root,
      launchBrowser: async () => {
        launchCalled = true;
        throw new Error(
          "stub: launchBrowser reached, aborting before any real browser work",
        );
      },
    });

    assert.equal(
      launchCalled,
      true,
      "a matching build source map must let the probe reach launchBrowser",
    );
    assert.equal(result.artifact.status, "ERROR");
    assert.equal(result.artifact.diagnostics.stage, "node");
    assert.match(
      result.artifact.diagnostics.errorMessage,
      /stub: launchBrowser reached/,
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});
