// @purpose Q-99/Q-153 — regression coverage for the shared build-vs-source-tree
// identity check (`inspectBuildSourceIdentity` / `compareBuildSourceIdentity`
// in `lib/build-source-identity.mjs`), the primitive the replacement-device
// probe already gates a browser launch on and the dense-cost and multiview
// probes now gate on too. A fixture source map with matching sourcesContent
// must report `ok: true`; one with drifted, absent, or duplicated
// sourcesContent must report `ok: false` with a reason naming the file. Q-153
// (2026-09-02) added the foreign-absolute-root fixtures below: a source map
// whose `sources` entries are rooted at a directory unrelated to the tree
// being checked (a build's original repo root, served to a worker clone)
// must still match by repository-relative path SUFFIX, and currency is still
// decided only by the `sourcesContent` hash.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/build-source-identity.spec.mjs
//
// No browser, no dev server, no real build — every fixture is a temp
// directory holding a hand-built `.js.map` plus the "source" files it
// claims to embed.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  compareBuildSourceIdentity,
  inspectBuildSourceIdentity,
} from "./lib/build-source-identity.mjs";

async function makeFixture(root, { sourceText, mapSourcesContent }) {
  const sourcePath = path.join(root, "Fixture.js");
  await writeFile(sourcePath, sourceText, "utf8");
  const mapPath = path.join(root, "index.js.map");
  await writeFile(
    mapPath,
    JSON.stringify({
      version: 3,
      sources: ["./Fixture.js"],
      sourcesContent: [mapSourcesContent],
    }),
    "utf8",
  );
  return { sourcePath, mapPath };
}

test("inspectBuildSourceIdentity: matching sourcesContent reports ok:true with no reasons", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "build-source-identity-match-"),
  );
  try {
    const text = "export const value = 1;\n";
    const { sourcePath, mapPath } = await makeFixture(root, {
      sourceText: text,
      mapSourcesContent: text,
    });

    const result = inspectBuildSourceIdentity({
      sourceMapPath: mapPath,
      sourceFiles: [sourcePath],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].exact, true);
    assert.equal(
      result.entries[0].currentSha256,
      result.entries[0].embeddedSha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectBuildSourceIdentity: drifted sourcesContent reports ok:false naming the file", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "build-source-identity-drift-"),
  );
  try {
    const { sourcePath, mapPath } = await makeFixture(root, {
      sourceText: "export const value = 2;\n", // current on-disk source
      mapSourcesContent: "export const value = 1;\n", // what the build embedded
    });

    const result = inspectBuildSourceIdentity({
      sourceMapPath: mapPath,
      sourceFiles: [sourcePath],
    });

    assert.equal(result.ok, false);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /Fixture\.js/);
    assert.match(
      result.reasons[0],
      /current source bytes differ from built sourcesContent/,
    );
    assert.equal(result.entries[0].exact, false);
    assert.notEqual(
      result.entries[0].currentSha256,
      result.entries[0].embeddedSha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectBuildSourceIdentity: a source absent from the build's source map reports ok:false", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "build-source-identity-absent-"),
  );
  try {
    const mapPath = path.join(root, "index.js.map");
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: ["./SomeOtherFile.js"],
        sourcesContent: ["export const other = true;\n"],
      }),
      "utf8",
    );
    const sourcePath = path.join(root, "Fixture.js");
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");

    const result = inspectBuildSourceIdentity({
      sourceMapPath: mapPath,
      sourceFiles: [sourcePath],
    });

    assert.equal(result.ok, false);
    assert.match(result.reasons[0], /source is absent from build source map/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compareBuildSourceIdentity: a source resolving to two source-map entries is ambiguous, not silently picked", () => {
  const result = compareBuildSourceIdentity({
    sourceMap: {
      sources: ["./Fixture.js", "./Fixture.js"],
      sourcesContent: ["export const a = 1;\n", "export const a = 1;\n"],
    },
    sourceMapPath: "/repo/Build/index.js.map",
    sources: [
      {
        file: "/repo/Build/Fixture.js",
        bytes: Buffer.from("export const a = 1;\n"),
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /resolves to 2 build source-map entries/);
});

// Mutation check (CLAUDE.md Principle 10): a comparator that only checks
// byte LENGTH (not content) would pass a same-length drift. Prove the check
// is a real byte comparison, not a length check, with a same-length mutant.
test("mutant check: same-length but different-content sourcesContent is still detected as drift", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "build-source-identity-samelen-"),
  );
  try {
    const built = "export const value = 1;\n"; // 25 bytes
    const current = "export const value = 2;\n"; // 25 bytes, differs by one char
    assert.equal(built.length, current.length);
    const { sourcePath, mapPath } = await makeFixture(root, {
      sourceText: current,
      mapSourcesContent: built,
    });

    const result = inspectBuildSourceIdentity({
      sourceMapPath: mapPath,
      sourceFiles: [sourcePath],
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.entries[0].currentByteLength,
      result.entries[0].embeddedByteLength,
    );
    assert.notEqual(
      result.entries[0].currentSha256,
      result.entries[0].embeddedSha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── Q-153: a source map rooted at a foreign absolute directory ─────────────
//
// Fixture shape lifted directly from the Q-153 evidence
// (Tools/visual-regression/output/eclipse-cloud-response-2026-09-02/README.txt):
// the map's `sources` entries are ABSOLUTE URLs rooted at a directory that
// shares nothing with the tree being checked — a build's original repo root,
// served to a worker clone under an unrelated path — while the embedded
// `sourcesContent` is byte-identical to the clone's own files. `repoRoot`
// lets the check resolve each (repo-relative) `sourceFiles` entry against
// the tree actually being checked, independent of `process.cwd()`.

/**
 * Builds a fixture whose source map's `sources` entry is rooted at a
 * FOREIGN absolute directory unrelated to `root` — Q-153's exact shape.
 *
 * @param {string} root Temp directory standing in for the repository root.
 * @param {object} options
 * @param {string} options.relativePath Repository-relative path, e.g.
 * `"packages/engine/Source/Scene/Fixture.js"`.
 * @param {string} options.sourceText Bytes written to the on-disk file (the
 * tree being checked).
 * @param {string} options.mapSourcesContent Bytes the map claims to embed
 * (what the build saw).
 * @returns {Promise<{sourcePath: string, mapPath: string}>}
 */
async function makeForeignRootFixture(root, options) {
  const { relativePath, sourceText, mapSourcesContent } = options;
  const foreignRoot = "file:///Z:/unrelated-repo-root";
  const sourcePath = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, sourceText, "utf8");
  const mapPath = path.join(root, "Build", "index.js.map");
  await mkdir(path.dirname(mapPath), { recursive: true });
  await writeFile(
    mapPath,
    JSON.stringify({
      version: 3,
      sources: [`${foreignRoot}/${relativePath}`],
      sourcesContent: [mapSourcesContent],
    }),
    "utf8",
  );
  return { sourcePath, mapPath };
}

test("inspectBuildSourceIdentity: a source map rooted at a foreign absolute directory matches by repository-relative suffix", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "build-source-identity-foreign-root-"),
  );
  try {
    const text = "export const value = 1;\n";
    const relativePath = "packages/engine/Source/Scene/Fixture.js";
    await makeForeignRootFixture(root, {
      relativePath,
      sourceText: text,
      mapSourcesContent: text,
    });
    const mapPath = path.join(root, "Build", "index.js.map");

    const result = inspectBuildSourceIdentity({
      sourceMapPath: mapPath,
      sourceFiles: [relativePath],
      repoRoot: root,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].exact, true);
    assert.equal(result.entries[0].matchedBy, "suffix");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectBuildSourceIdentity: a foreign-rooted entry with stale content refuses distinctly from a missing one", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "build-source-identity-foreign-stale-"),
  );
  try {
    const relativePath = "packages/engine/Source/Scene/Fixture.js";
    await makeForeignRootFixture(root, {
      relativePath,
      sourceText: "export const value = 2;\n", // current, on the checked tree
      mapSourcesContent: "export const value = 1;\n", // what the build embedded
    });
    const mapPath = path.join(root, "Build", "index.js.map");

    const result = inspectBuildSourceIdentity({
      sourceMapPath: mapPath,
      sourceFiles: [relativePath],
      repoRoot: root,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /Fixture\.js/);
    assert.match(
      result.reasons[0],
      /current source bytes differ from built sourcesContent/,
    );
    assert.doesNotMatch(result.reasons[0], /absent from build source map/);
    assert.equal(result.entries[0].matchedBy, "suffix");
    assert.equal(result.entries[0].exact, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectBuildSourceIdentity: a foreign-rooted map with no matching suffix anywhere still refuses as missing", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "build-source-identity-foreign-missing-"),
  );
  try {
    const relativePath = "packages/engine/Source/Scene/Fixture.js";
    const mapPath = path.join(root, "Build", "index.js.map");
    await mkdir(path.dirname(mapPath), { recursive: true });
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: [
          "file:///Z:/unrelated-repo-root/packages/engine/Source/Scene/SomeOtherFile.js",
        ],
        sourcesContent: ["export const other = true;\n"],
      }),
      "utf8",
    );
    const sourcePath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");

    const result = inspectBuildSourceIdentity({
      sourceMapPath: mapPath,
      sourceFiles: [relativePath],
      repoRoot: root,
    });

    assert.equal(result.ok, false);
    assert.match(result.reasons[0], /source is absent from build source map/);
    assert.equal(result.entries[0].matchedBy, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Mutation check (CLAUDE.md Principle 10): disable the suffix-match branch
// on a COPY of the live source (never the file on disk) and require the
// foreign-root fixture above to regress to the pre-fix "absent from build
// source map" refusal — proving the passing test above is anchored to the
// suffix-match code, not merely to the fixture shape.
test("mutant check: disabling the suffix match reverts the foreign-root fixture to the old false refusal", async () => {
  const libPath = fileURLToPath(
    new URL("./lib/build-source-identity.mjs", import.meta.url),
  );
  const original = await readFile(libPath, "utf8");
  const anchor = "if (isAbsoluteMatch || isSuffixMatch) {";
  const mutatedLine = "if (isAbsoluteMatch || (false && isSuffixMatch)) {";
  assert.ok(
    original.includes(anchor),
    "the mutation anchor must exist in the live source, or this mutation " +
      "test is not exercising the real match branch",
  );
  const mutatedSource = original.replace(anchor, mutatedLine);
  assert.notEqual(
    mutatedSource,
    original,
    "the mutation must actually change the source",
  );

  const scratchDir = await mkdtemp(
    path.join(tmpdir(), "build-source-identity-mutant-"),
  );
  const root = await mkdtemp(
    path.join(tmpdir(), "build-source-identity-mutant-fixture-"),
  );
  try {
    const mutantPath = path.join(
      scratchDir,
      "build-source-identity.mutant.mjs",
    );
    await writeFile(mutantPath, mutatedSource, "utf8");
    const mutant = await import(pathToFileURL(mutantPath).href);

    const relativePath = "packages/engine/Source/Scene/Fixture.js";
    const text = "export const value = 1;\n";
    await makeForeignRootFixture(root, {
      relativePath,
      sourceText: text,
      mapSourcesContent: text,
    });
    const mapPath = path.join(root, "Build", "index.js.map");

    const result = mutant.inspectBuildSourceIdentity({
      sourceMapPath: mapPath,
      sourceFiles: [relativePath],
      repoRoot: root,
    });

    assert.equal(
      result.ok,
      false,
      "with the suffix-match branch disabled, the foreign-root fixture " +
        "must regress to the pre-fix behaviour (no match) — if it still " +
        "passes, the earlier suffix-match test is not anchored to this code",
    );
    assert.match(result.reasons[0], /source is absent from build source map/);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
