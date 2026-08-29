// Q-95 — browser-free regression coverage for the extracted clean-vs-preserve
// decision `buildCesium` makes before it writes into `outputDirectory`.
// @purpose Regression that `clean:false` never removes files already on disk while `clean:true` still wipes the directory, so a failed rebuild cannot leave a served bundle directory both wiped and unreplaced.
// @status ACTIVE
//
// Run: node --test scripts/__tests__/prepareCesiumOutputDirectory.spec.mjs
//
// This does not invoke esbuild or any part of the real bundling pipeline —
// `prepareCesiumOutputDirectory` is pure filesystem logic (rimraf vs mkdirp),
// extracted from `buildCesium` specifically so it can be exercised here
// without running a build.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareCesiumOutputDirectory } from "../build.js";

/** Creates a throwaway directory pre-populated the way a previous successful
 * `buildCesium` run would leave it: an entry bundle plus the shared asset
 * directories that later steps (bundleCSS / bundleWorkers) repopulate on
 * every call regardless of `clean`. */
async function makePriorBuildOutput() {
  const dir = await mkdtemp(path.join(tmpdir(), "prepare-cesium-output-"));
  await mkdir(path.join(dir, "ThirdParty"), { recursive: true });
  await mkdir(path.join(dir, "Widgets"), { recursive: true });
  await mkdir(path.join(dir, "Workers"), { recursive: true });
  await writeFile(path.join(dir, "Cesium.js"), "/* prior build */", "utf8");
  await writeFile(path.join(dir, "index.js"), "/* prior build */", "utf8");
  await writeFile(path.join(dir, "index.js.map"), "{}", "utf8");
  return dir;
}

test("clean:true wipes an existing output directory (today's default behaviour, unchanged)", async () => {
  const dir = await makePriorBuildOutput();
  try {
    prepareCesiumOutputDirectory(dir, true);

    // rimraf removes the directory itself; nothing survives, and the
    // directory need not even exist afterward (buildCesium's later steps
    // recreate it on write).
    assert.equal(existsSync(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clean:false preserves the previous successful build's entry bundle", async () => {
  const dir = await makePriorBuildOutput();
  try {
    prepareCesiumOutputDirectory(dir, false);

    // The served bundle from the LAST successful build must still be on
    // disk — this is the Q-95 guarantee: a rebuild that hasn't finished
    // writing a replacement yet must never leave the tree with nothing
    // servable.
    assert.equal(existsSync(path.join(dir, "Cesium.js")), true);
    assert.equal(existsSync(path.join(dir, "index.js")), true);
    assert.equal(existsSync(path.join(dir, "index.js.map")), true);

    const entries = (await readdir(dir)).sort();
    assert.deepEqual(entries, [
      "Cesium.js",
      "ThirdParty",
      "Widgets",
      "Workers",
      "index.js",
      "index.js.map",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clean:false still ensures a missing output directory exists (first-ever build)", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "prepare-cesium-output-"));
  const dir = path.join(parent, "Build", "CesiumUnminified");
  try {
    assert.equal(existsSync(dir), false);

    prepareCesiumOutputDirectory(dir, false);

    assert.equal(existsSync(dir), true);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// Mutation check (CLAUDE.md Principle 10): a helper that always calls
// mkdirp — never rimraf — regardless of `clean` would pass a naive
// "directory exists after the call" assertion for BOTH branches. Prove the
// clean:true assertion actually distinguishes real removal from a no-op by
// inverting the predicate an inert version would satisfy: if
// `prepareCesiumOutputDirectory` never removed anything, a stale file
// planted before a `clean:true` call would still be there afterward.
test("mutant check: clean:true must actually remove a stale file, not merely leave the directory present", async () => {
  const dir = await makePriorBuildOutput();
  const staleMarker = path.join(dir, "stale-from-removed-source.js");
  await writeFile(
    staleMarker,
    "/* should not survive a clean build */",
    "utf8",
  );
  try {
    prepareCesiumOutputDirectory(dir, true);

    // An inert mutant (`clean` ignored, always mkdirp) would leave the
    // directory existing AND the stale marker inside it. The real
    // behaviour must fail this assertion in the opposite way: the
    // directory itself is gone, so the marker cannot exist either.
    assert.equal(existsSync(staleMarker), false);
    assert.equal(existsSync(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
