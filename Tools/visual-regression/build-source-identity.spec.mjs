// @purpose Q-99 — regression coverage for the shared build-vs-source-tree
// identity check (`inspectBuildSourceIdentity` / `compareBuildSourceIdentity`
// in `lib/build-source-identity.mjs`), the primitive the replacement-device
// probe already gates a browser launch on and the dense-cost and multiview
// probes now gate on too. A fixture source map with matching sourcesContent
// must report `ok: true`; one with drifted, absent, or duplicated
// sourcesContent must report `ok: false` with a reason naming the file.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/build-source-identity.spec.mjs
//
// No browser, no dev server, no real build — every fixture is a temp
// directory holding a hand-built `.js.map` plus the "source" files it
// claims to embed.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
