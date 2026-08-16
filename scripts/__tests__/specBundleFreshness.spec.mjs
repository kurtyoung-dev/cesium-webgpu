// C11-132 — spec-bundle freshness sentinel. Browser-free Node coverage for the
// digest/compare/handshake logic that decides whether the SpecList bundle Karma
// is about to serve was built from the spec sources currently on disk.
// @purpose Coverage of the spec-bundle freshness sentinel: added/removed/changed spec files must flip the manifest comparison stale and name the offender.
// @status ACTIVE
//
// The acceptance oracle from the guide is a delta: a brand-new spec must NOT be
// silently absent from the served bundle. That delta is reproduced here without
// Karma by driving the same functions the gulp task calls — an added spec, a
// removed spec, and a content-changed spec each have to flip `fresh` to false
// and name the offending file.
//
// Run: node --test scripts/__tests__/specBundleFreshness.spec.mjs

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SPEC_MANIFEST_FILENAME,
  SPEC_MANIFEST_VERSION,
  buildSpecManifest,
  checkSpecBundleFreshness,
  compareSpecManifests,
  ensureSpecBundleFresh,
  formatSpecFreshnessReport,
  getSpecBundleTarget,
  hashSpecSource,
  normalizeSpecPath,
  readSpecBundleManifest,
  specBundleTargets,
  stampSpecBundleManifest,
} from "../specBundleFreshness.js";

const ENGINE_SPEC_DIR = "packages/engine/Specs";
const ENGINE_BUNDLE_DIR = "packages/engine/Build/Specs";

/** Creates a throwaway workspace shaped like the engine spec tree. */
async function makeSandbox(specs) {
  const cwd = await mkdtemp(path.join(tmpdir(), "spec-freshness-"));
  await mkdir(path.join(cwd, ENGINE_SPEC_DIR, "Core"), { recursive: true });
  await mkdir(path.join(cwd, ENGINE_BUNDLE_DIR), { recursive: true });
  for (const [relative, contents] of Object.entries(specs)) {
    const target = path.join(cwd, ENGINE_SPEC_DIR, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return cwd;
}

async function writeSpec(cwd, relative, contents) {
  const target = path.join(cwd, ENGINE_SPEC_DIR, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

const BASELINE_SPECS = {
  "Core/AlphaSpec.js": "describe('Alpha', () => {});\n",
  "Core/BetaSpec.js": "describe('Beta', () => {});\n",
};

test("targets cover every lane gulp test can point Karma at", () => {
  assert.deepEqual(Object.keys(specBundleTargets).sort(), [
    "combined",
    "engine",
    "widgets",
  ]);
  assert.equal(
    getSpecBundleTarget("engine").bundleDirectory,
    "packages/engine/Build/Specs",
  );
  assert.equal(getSpecBundleTarget("combined").bundleDirectory, "Build/Specs");
  // The combined lane must see BOTH workspaces — a widgets-only drift is just
  // as invisible as an engine-only one.
  assert.equal(getSpecBundleTarget("combined").specGlobs.length, 2);
  assert.throws(
    () => getSpecBundleTarget("nope"),
    /Unknown spec-bundle target/,
  );
});

test("the digest is content-derived, path-order-independent, and OS-independent", () => {
  const a = buildSpecManifest("engine", [
    { path: "packages/engine/Specs/Core/AlphaSpec.js", contents: "one" },
    { path: "packages/engine/Specs/Core/BetaSpec.js", contents: "two" },
  ]);
  const b = buildSpecManifest("engine", [
    { path: "packages/engine/Specs/Core/BetaSpec.js", contents: "two" },
    { path: "packages/engine/Specs/Core/AlphaSpec.js", contents: "one" },
  ]);
  assert.equal(a.digest, b.digest, "glob order must not change the digest");
  assert.equal(a.version, SPEC_MANIFEST_VERSION);
  assert.equal(a.fileCount, 2);

  // Windows separators normalize, so a manifest stamped on Windows compares
  // equal to one stamped on Linux (trap 4's platform half).
  const windowsStyle = buildSpecManifest("engine", [
    { path: "packages\\engine\\Specs\\Core\\AlphaSpec.js", contents: "one" },
    { path: "packages\\engine\\Specs\\Core\\BetaSpec.js", contents: "two" },
  ]);
  assert.equal(
    normalizeSpecPath("packages\\engine\\Specs\\Core\\AlphaSpec.js").includes(
      "\\",
    ),
    process.platform !== "win32",
    "normalizeSpecPath splits on the host separator",
  );
  if (process.platform === "win32") {
    assert.equal(windowsStyle.digest, a.digest);
  }

  // Content, not mtime: same paths, different bytes -> different digest.
  const changed = buildSpecManifest("engine", [
    { path: "packages/engine/Specs/Core/AlphaSpec.js", contents: "one" },
    { path: "packages/engine/Specs/Core/BetaSpec.js", contents: "two!" },
  ]);
  assert.notEqual(changed.digest, a.digest);
  assert.notEqual(hashSpecSource("one"), hashSpecSource("two"));
});

test("compare classifies added, removed and changed specs separately", () => {
  const recorded = buildSpecManifest("engine", [
    { path: "a/AlphaSpec.js", contents: "one" },
    { path: "a/BetaSpec.js", contents: "two" },
  ]);
  const current = buildSpecManifest("engine", [
    { path: "a/AlphaSpec.js", contents: "one" },
    { path: "a/BetaSpec.js", contents: "two-edited" },
    { path: "a/GammaSpec.js", contents: "three" },
  ]);

  const comparison = compareSpecManifests(current, recorded);
  assert.equal(comparison.fresh, false);
  assert.equal(comparison.reason, "spec-set-drift");
  assert.deepEqual(comparison.added, ["a/GammaSpec.js"]);
  assert.deepEqual(comparison.changed, ["a/BetaSpec.js"]);
  assert.deepEqual(comparison.removed, []);

  // The mirror failure: a deleted spec still living in the bundle (trap 1).
  const afterDelete = buildSpecManifest("engine", [
    { path: "a/AlphaSpec.js", contents: "one" },
  ]);
  const deletion = compareSpecManifests(afterDelete, recorded);
  assert.equal(deletion.fresh, false);
  assert.deepEqual(deletion.removed, ["a/BetaSpec.js"]);
  assert.deepEqual(deletion.added, []);

  assert.equal(compareSpecManifests(current, current).fresh, true);
});

test("a missing, stale-schema or foreign manifest is stale, never trusted", () => {
  const current = buildSpecManifest("engine", [
    { path: "a/AlphaSpec.js", contents: "one" },
  ]);
  assert.equal(compareSpecManifests(current, null).reason, "manifest-missing");
  assert.equal(
    compareSpecManifests(current, { ...current, version: 0 }).reason,
    "manifest-version",
  );
  assert.equal(
    compareSpecManifests(current, { ...current, target: "widgets" }).reason,
    "manifest-target-mismatch",
  );
});

test("the staleness report names the exact drifted files", () => {
  const comparison = compareSpecManifests(
    buildSpecManifest("engine", [
      { path: "a/AlphaSpec.js", contents: "one" },
      { path: "a/BrandNewSpec.js", contents: "new" },
    ]),
    buildSpecManifest("engine", [
      { path: "a/AlphaSpec.js", contents: "one" },
      { path: "a/DeletedSpec.js", contents: "gone" },
    ]),
  );
  const report = formatSpecFreshnessReport("engine", comparison);
  assert.match(report, /STALE/);
  assert.match(report, /a\/BrandNewSpec\.js/);
  assert.match(report, /a\/DeletedSpec\.js/);
  assert.match(report, /npx gulp test --workspace engine/);
  assert.match(
    formatSpecFreshnessReport("engine", { fresh: true }),
    /is fresh/,
  );
});

test("stamp then check round-trips against a real bundle directory", async () => {
  const cwd = await makeSandbox(BASELINE_SPECS);
  try {
    const stamped = await stampSpecBundleManifest("engine", { cwd });
    assert.equal(stamped.fileCount, 2);

    const onDisk = JSON.parse(
      await readFile(
        path.join(cwd, ENGINE_BUNDLE_DIR, SPEC_MANIFEST_FILENAME),
        "utf8",
      ),
    );
    assert.equal(onDisk.digest, stamped.digest);
    assert.deepEqual(await readSpecBundleManifest("engine", { cwd }), onDisk);

    const fresh = await checkSpecBundleFreshness("engine", { cwd });
    assert.equal(fresh.fresh, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("THE TRAP: a brand-new spec makes the served bundle stale and is named", async () => {
  const cwd = await makeSandbox(BASELINE_SPECS);
  try {
    await stampSpecBundleManifest("engine", { cwd });

    // This is the guide's Step 0 premise, minus Karma: a spec that was added
    // after the bundle was built. Before this sentinel it would have "passed"
    // by never running.
    await writeSpec(
      cwd,
      "Core/BrandNewSpec.js",
      "describe('BrandNew', () => { it('fails', () => expect(true).toBe(false)); });\n",
    );

    const stale = await checkSpecBundleFreshness("engine", { cwd });
    assert.equal(stale.fresh, false);
    assert.deepEqual(stale.comparison.added, [
      "packages/engine/Specs/Core/BrandNewSpec.js",
    ]);
    assert.match(stale.report, /BrandNewSpec\.js/);

    // ...and a delete is caught the same way.
    await rm(path.join(cwd, ENGINE_SPEC_DIR, "Core/AlphaSpec.js"));
    const afterDelete = await checkSpecBundleFreshness("engine", { cwd });
    assert.deepEqual(afterDelete.comparison.removed, [
      "packages/engine/Specs/Core/AlphaSpec.js",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ensure: fresh skips the rebuild, stale rebuilds once, unfixable throws", async () => {
  const cwd = await makeSandbox(BASELINE_SPECS);
  try {
    await stampSpecBundleManifest("engine", { cwd });

    // Fast inner loop (step 3): a matching digest must not trigger a rebuild.
    let rebuilds = 0;
    const untouched = await ensureSpecBundleFresh("engine", {
      cwd,
      rebuild: async () => {
        rebuilds++;
      },
    });
    assert.equal(untouched.fresh, true);
    assert.equal(untouched.rebuilt, false);
    assert.equal(rebuilds, 0);

    // Stale: rebuild once, then serve.
    await writeSpec(cwd, "Core/GammaSpec.js", "describe('Gamma', () => {});\n");
    const logs = [];
    const repaired = await ensureSpecBundleFresh("engine", {
      cwd,
      log: (message) => logs.push(message),
      rebuild: async (target) => {
        rebuilds++;
        await stampSpecBundleManifest(target, { cwd });
      },
    });
    assert.equal(repaired.fresh, true);
    assert.equal(repaired.rebuilt, true);
    assert.equal(rebuilds, 1);
    assert.match(logs.join("\n"), /GammaSpec\.js/);

    // A rebuild that does not actually refresh the bundle must fail loudly
    // rather than let Karma run against an unknown spec set.
    await writeSpec(cwd, "Core/DeltaSpec.js", "describe('Delta', () => {});\n");
    await assert.rejects(
      ensureSpecBundleFresh("engine", {
        cwd,
        rebuild: async () => {
          /* deliberately does not restamp */
        },
      }),
      /did not make the bundle fresh/,
    );

    // With no rebuild hook at all, staleness is fatal immediately.
    await assert.rejects(ensureSpecBundleFresh("engine", { cwd }), /is STALE/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
