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
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  mkLaneTmp,
  removeLaneTmp,
  withLaneTmp,
} from "../../Tools/lib/lane-tmp.mjs";
import {
  SPEC_MANIFEST_FILENAME,
  SPEC_MANIFEST_VERSION,
  buildSpecManifest,
  checkSpecBundleFreshness,
  checkSpecLaneFreshness,
  compareSpecManifests,
  computeSpecManifest,
  decideSpecLaneRebuild,
  deriveRecord,
  engineWorkersRecord,
  ensureSpecBundleFresh,
  ensureSpecLaneFresh,
  formatSpecFreshnessReport,
  getSpecBundleTarget,
  getSpecTestLane,
  hashSpecSource,
  normalizeSpecPath,
  outputRecord,
  readRecord,
  readSpecBundleManifest,
  recordPath,
  resolveSpecTestLane,
  runStampedBuild,
  specBundleTargets,
  specRecord,
  specTestLanes,
  takeSourceSnapshot,
  testWorkersRecord,
} from "../specBundleFreshness.js";
import { karmaFilesForLane, planSpecTestLane } from "../specTestLanePlan.js";

const ENGINE_SPEC_DIR = "packages/engine/Specs";
const ENGINE_BUNDLE_DIR = "packages/engine/Build/Specs";

/** Creates a throwaway workspace (under the lane temp root) shaped like the engine spec tree. */
async function makeSandbox(specs) {
  const cwd = mkLaneTmp("spec-freshness-");
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

/**
 * Stamps the given records the only way a record is written: through
 * `runStampedBuild`, here with a build that writes nothing.
 */
function stamp(cwd, ...descriptors) {
  return runStampedBuild(descriptors, async () => {}, { cwd });
}

/** Stamps every record a lane reads, as its full build would. */
function stampLane(cwd, laneKey) {
  const lane = getSpecTestLane(laneKey);
  return stamp(cwd, specRecord(lane.specTarget), ...lane.records);
}

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
    await stamp(cwd, specRecord("engine"));
    const stamped = await computeSpecManifest("engine", { cwd });
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
    removeLaneTmp(cwd);
  }
});

test("THE TRAP: a brand-new spec makes the served bundle stale and is named", async () => {
  const cwd = await makeSandbox(BASELINE_SPECS);
  try {
    await stamp(cwd, specRecord("engine"));

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
    removeLaneTmp(cwd);
  }
});

// `ensureSpecBundleFresh` guards one spec bundle alone; `gulp test` runs
// `ensureSpecLaneFresh` instead (the `hook:` and `source:` tests below).
test("ensure (kept, no gulp caller): fresh skips the rebuild, stale rebuilds once, unfixable throws", async () => {
  const cwd = await makeSandbox(BASELINE_SPECS);
  try {
    await stamp(cwd, specRecord("engine"));

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
        await stamp(cwd, specRecord(target));
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
    removeLaneTmp(cwd);
  }
});

// ---------------------------------------------------------------------------
// Source inputs: the bundles inline engine/widgets source and Specs helpers, so
// an edit to any of them (with no spec change) must make the bundle stale.
// ---------------------------------------------------------------------------

const ENGINE_SOURCE = "packages/engine/Source/Core/Thing.js";
const ENGINE_SHADER = "packages/engine/Source/Shaders/Thing.glsl";
const ENGINE_TS = "packages/engine/Source/Core/Typed.ts";
const ENGINE_WGSL = "packages/engine/Source/Shaders/Thing.wgsl";
const ENGINE_GENERATED_SHADER = "packages/engine/Source/Shaders/Thing.js";
const ENGINE_PIN = "packages/engine/package.json";
const LOCK_PIN = "node_modules/.package-lock.json";
const ENGINE_ASSET = "packages/engine/Source/Assets/logo.json";
const ENGINE_HELPER = "packages/engine/Specs/createHelper.js";
const ROOT_HELPER = "Specs/createScene.js";
const WIDGETS_SOURCE = "packages/widgets/Source/Viewer/Viewer.js";
const WIDGETS_HELPER = "packages/widgets/Specs/createViewer.js";
const ENGINE_SPEC = "packages/engine/Specs/Core/AlphaSpec.js";
const WIDGETS_SPEC = "packages/widgets/Specs/Viewer/ViewerSpec.js";
const ENGINE_WASM =
  "packages/engine/Source/ThirdParty/Workers/cesium_wasm_bg.wasm";
const COPIED_THIRD_PARTY =
  "packages/engine/Source/ThirdParty/Workers/draco_decoder_nodejs.js";
const TEST_WORKER = "Specs/TestWorkers/returnParameters.js";
const BUILD_SCRIPT = "scripts/build.js";

/** The engine and widgets lanes' other records (engine and test workers), current. */
const FRESH_WORKSPACE_RECORDS = [
  { fresh: true, reason: "fresh" },
  { fresh: true, reason: "fresh" },
];

const SOURCE_TREE = {
  [ENGINE_WASM]: "\0asm\u0001\0\0\0",
  [TEST_WORKER]: "export default function returnParameters() {}\n",
  [BUILD_SCRIPT]: "// the build tooling\n",
  "gulpfile.js": "// the gulp tasks\n",
  [ENGINE_SOURCE]: "export default 1;\n",
  [ENGINE_SHADER]: "void main() {}\n",
  [ENGINE_TS]: "export const typed: number = 1;\n",
  [ENGINE_WGSL]: "fn main() {}\n",
  [ENGINE_GENERATED_SHADER]: "export default 'void main() {}';\n",
  "package.json": '{"name":"root"}\n',
  [ENGINE_PIN]: '{"name":"engine"}\n',
  "packages/widgets/package.json": '{"name":"widgets"}\n',
  [LOCK_PIN]: '{"packages":{}}\n',
  [ENGINE_ASSET]: "{}\n",
  [ENGINE_HELPER]: "export default function createHelper() {}\n",
  "packages/engine/Specs/SpecList.js": "// generated\n",
  "packages/engine/Specs/Data/fixture.js": "export default 1;\n",
  "packages/engine/Specs/e2e/probe.js": "export default 1;\n",
  "packages/engine/Specs/jasmine/jasmine.js": "export default 1;\n",
  [ENGINE_SPEC]: "describe('Alpha', () => {});\n",
  [ROOT_HELPER]: "export default function createScene() {}\n",
  "Specs/SpecList.js": "// generated\n",
  "Specs/Data/model.js": "export default 1;\n",
  [WIDGETS_SOURCE]: "export default 2;\n",
  [WIDGETS_HELPER]: "export default function createViewer() {}\n",
  [WIDGETS_SPEC]: "describe('Viewer', () => {});\n",
};

async function writeAt(cwd, relative, contents) {
  const target = path.join(cwd, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

/** Runs `body(cwd)` in a lane-tmp sandbox holding SOURCE_TREE. */
function withSourceSandbox(body) {
  return withLaneTmp("freshness-", async (cwd) => {
    for (const [relative, contents] of Object.entries(SOURCE_TREE)) {
      await writeAt(cwd, relative, contents);
    }
    return body(cwd);
  });
}

/**
 * Runs the test task's handshake, `ensureSpecLaneFresh`, for a lane with
 * builds that really re-stamp the sandbox: the full build stamps every record
 * the lane reads, the narrow one the spec bundle's. Returns each build call
 * with the spec-bundle comparison the lane saw.
 */
async function ensureWithStampingHook(laneKey, cwd) {
  const lane = getSpecTestLane(laneKey);
  const calls = [];
  const record = async (target, kind) => {
    calls.push({
      target,
      kind,
      comparison: (await checkSpecBundleFreshness(lane.specTarget, { cwd }))
        .comparison,
    });
  };
  const result = await ensureSpecLaneFresh(laneKey, {
    cwd,
    full: async (target) => {
      await record(target, "full");
      await stampLane(cwd, laneKey);
    },
    narrow: async (target) => {
      await record(target, "narrow");
      await stamp(cwd, specRecord(target));
    },
  });
  return { result, calls };
}

test("source: an engine source edit makes the bundle stale for the source drift and names the file", () =>
  withSourceSandbox(async (cwd) => {
    await stampLane(cwd, "engine");
    const stamped = await readSpecBundleManifest("engine", { cwd });
    assert.ok(stamped.sources[ENGINE_SOURCE], "the source is recorded");
    assert.ok(stamped.sources[ENGINE_SHADER], "shader sources are recorded");
    assert.equal(
      (await checkSpecBundleFreshness("engine", { cwd })).fresh,
      true,
    );

    await writeAt(cwd, ENGINE_SOURCE, "export default 2;\n");

    const stale = await checkSpecBundleFreshness("engine", { cwd });
    assert.equal(stale.fresh, false);
    assert.equal(stale.comparison.reason, "source-drift");
    assert.deepEqual(stale.comparison.changedSources, [ENGINE_SOURCE]);
    assert.deepEqual(stale.comparison.addedSources, []);
    assert.deepEqual(stale.comparison.removedSources, []);
    assert.deepEqual(stale.comparison.added, []);
    assert.deepEqual(stale.comparison.removed, []);
    assert.deepEqual(stale.comparison.changed, []);
    assert.ok(stale.report.includes(ENGINE_SOURCE), stale.report);
    assert.ok(stale.report.includes("STALE"));
    assert.equal(
      decideSpecLaneRebuild("engine", stale.comparison, null),
      "full",
    );

    const { result, calls } = await ensureWithStampingHook("engine", cwd);
    assert.equal(calls.length, 1, "the rebuild hook runs once");
    assert.equal(calls[0].target, "engine");
    assert.equal(calls[0].comparison.reason, "source-drift");
    assert.deepEqual(calls[0].comparison.changedSources, [ENGINE_SOURCE]);
    assert.equal(result.rebuilt, true);
    assert.equal(result.fresh, true);
  }));

test("source: added and deleted source files are detected and named", () =>
  withSourceSandbox(async (cwd) => {
    await stamp(cwd, specRecord("engine"));
    await writeAt(cwd, "packages/engine/Source/Core/Added.js", "export {};\n");
    await rm(path.join(cwd, ENGINE_SHADER));

    const stale = await checkSpecBundleFreshness("engine", { cwd });
    assert.equal(stale.comparison.reason, "source-drift");
    assert.deepEqual(stale.comparison.addedSources, [
      "packages/engine/Source/Core/Added.js",
    ]);
    assert.deepEqual(stale.comparison.removedSources, [ENGINE_SHADER]);
    assert.ok(stale.report.includes("Added.js"));
    assert.ok(stale.report.includes("Thing.glsl"));
  }));

test("source: Specs helper edits (root and engine) make the bundle stale", async () => {
  for (const helper of [ROOT_HELPER, ENGINE_HELPER]) {
    await withSourceSandbox(async (cwd) => {
      await stampLane(cwd, "engine");
      await writeAt(cwd, helper, "export default function edited() {}\n");

      const { result, calls } = await ensureWithStampingHook("engine", cwd);
      assert.equal(calls.length, 1, helper);
      assert.equal(calls[0].comparison.reason, "source-drift", helper);
      assert.deepEqual(calls[0].comparison.changedSources, [helper]);
      assert.equal(
        decideSpecLaneRebuild("engine", calls[0].comparison, null),
        "full",
      );
      assert.equal(result.fresh, true);
    });
  }
});

test("source: widgets and combined targets see engine and widgets source edits", () =>
  withSourceSandbox(async (cwd) => {
    await stamp(cwd, specRecord("widgets"), specRecord("combined"));

    // Widgets specs import engine, so an engine edit stales the widgets bundle.
    await writeAt(cwd, ENGINE_SOURCE, "export default 3;\n");
    for (const target of ["widgets", "combined"]) {
      const stale = await checkSpecBundleFreshness(target, { cwd });
      assert.equal(stale.comparison.reason, "source-drift", target);
      assert.deepEqual(stale.comparison.changedSources, [ENGINE_SOURCE]);
    }

    await stamp(cwd, specRecord("widgets"), specRecord("combined"));
    await writeAt(cwd, WIDGETS_SOURCE, "export default 4;\n");
    await writeAt(cwd, WIDGETS_HELPER, "export default function v2() {}\n");
    for (const target of ["widgets", "combined"]) {
      const stale = await checkSpecBundleFreshness(target, { cwd });
      assert.deepEqual(
        stale.comparison.changedSources,
        [WIDGETS_SOURCE, WIDGETS_HELPER].sort(),
        target,
      );
    }
  }));

test("source: nothing changed stays fresh and the rebuild hook is not called", () =>
  withSourceSandbox(async (cwd) => {
    for (const target of ["engine", "widgets", "combined"]) {
      await stampLane(cwd, target);
      const { result, calls } = await ensureWithStampingHook(target, cwd);
      assert.equal(calls.length, 0, target);
      assert.equal(result.fresh, true, target);
      assert.equal(result.rebuilt, false, target);
    }
  }));

test("source: spec-only drift keeps its lists, leaves source lists empty and routes narrow", () =>
  withSourceSandbox(async (cwd) => {
    await stamp(cwd, specRecord("engine"));
    await writeAt(cwd, "packages/engine/Specs/Core/NewSpec.js", "// new\n");
    await writeAt(cwd, ENGINE_SPEC, "describe('Alpha edited', () => {});\n");

    const stale = await checkSpecBundleFreshness("engine", { cwd });
    assert.equal(stale.comparison.reason, "spec-set-drift");
    assert.deepEqual(stale.comparison.added, [
      "packages/engine/Specs/Core/NewSpec.js",
    ]);
    assert.deepEqual(stale.comparison.changed, [ENGINE_SPEC]);
    assert.deepEqual(stale.comparison.addedSources, []);
    assert.deepEqual(stale.comparison.removedSources, []);
    assert.deepEqual(stale.comparison.changedSources, []);
    assert.equal(
      decideSpecLaneRebuild(
        "engine",
        stale.comparison,
        FRESH_WORKSPACE_RECORDS,
      ),
      "narrow",
    );

    await rm(path.join(cwd, ENGINE_SPEC));
    const removed = await checkSpecBundleFreshness("engine", { cwd });
    assert.deepEqual(removed.comparison.removed, [ENGINE_SPEC]);
    assert.deepEqual(removed.comparison.changedSources, []);
    assert.equal(
      decideSpecLaneRebuild(
        "engine",
        removed.comparison,
        FRESH_WORKSPACE_RECORDS,
      ),
      "narrow",
    );
    // The engine lane also serves the engine and test workers: without their
    // comparisons it is not current, so spec drift alone is not narrow.
    assert.equal(
      decideSpecLaneRebuild("engine", removed.comparison, null),
      "full",
    );
  }));

test("source: a spec change and a source change together report both", () =>
  withSourceSandbox(async (cwd) => {
    await stamp(cwd, specRecord("engine"));
    await writeAt(cwd, ENGINE_SPEC, "describe('Alpha edited', () => {});\n");
    await writeAt(cwd, ENGINE_SOURCE, "export default 9;\n");

    const stale = await checkSpecBundleFreshness("engine", { cwd });
    assert.equal(stale.fresh, false);
    assert.equal(stale.comparison.reason, "spec-and-source-drift");
    assert.deepEqual(stale.comparison.changed, [ENGINE_SPEC]);
    assert.deepEqual(stale.comparison.changedSources, [ENGINE_SOURCE]);
    assert.ok(stale.report.includes(ENGINE_SPEC));
    assert.ok(stale.report.includes(ENGINE_SOURCE));
    assert.equal(
      decideSpecLaneRebuild("engine", stale.comparison, null),
      "full",
    );
  }));

test("source: Assets, generated SpecList.js and Specs/Data edits are not bundle inputs; Assets are inputs of the output they are copied into", () =>
  withSourceSandbox(async (cwd) => {
    await stampLane(cwd, "combined");
    const stamped = await readSpecBundleManifest("combined", { cwd });
    const recorded = Object.keys(stamped.sources);
    for (const excluded of [
      ENGINE_ASSET,
      "packages/engine/Specs/SpecList.js",
      "Specs/SpecList.js",
      "packages/engine/Specs/Data/fixture.js",
      "Specs/Data/model.js",
      "packages/engine/Specs/e2e/probe.js",
      "packages/engine/Specs/jasmine/jasmine.js",
      ENGINE_SPEC,
    ]) {
      assert.ok(!recorded.includes(excluded), excluded);
    }

    await writeAt(cwd, "packages/engine/Specs/SpecList.js", "// rewritten\n");
    await writeAt(cwd, "Specs/SpecList.js", "// rewritten\n");
    await writeAt(cwd, "packages/engine/Specs/Data/fixture.js", "edited\n");
    await writeAt(cwd, "Specs/Data/model.js", "edited\n");
    await writeAt(cwd, "Specs/Data/brandNew.js", "added\n");

    const { calls } = await ensureWithStampingHook("combined", cwd);
    assert.equal(calls.length, 0, "none of these edits makes it stale");
    assert.equal(
      (await checkSpecBundleFreshness("combined", { cwd })).fresh,
      true,
    );

    // An asset is not in the spec bundle, but the build copies it into the
    // output directory the lane serves.
    await writeAt(cwd, ENGINE_ASSET, "{ }\n");
    const asset = await checkSpecLaneFreshness("combined", { cwd });
    assert.equal(asset.spec.fresh, true);
    assert.deepEqual(asset.output.comparison.changedSources, [ENGINE_ASSET]);
    assert.equal(asset.decision, "full");
  }));

test("source: a version-1 manifest is stale as manifest-version once, then fresh after one rebuild", () =>
  withSourceSandbox(async (cwd) => {
    // A real v1-shaped manifest: version 1, spec record only, no source record.
    await writeAt(
      cwd,
      path.join(ENGINE_BUNDLE_DIR, SPEC_MANIFEST_FILENAME),
      `${JSON.stringify(
        {
          version: 1,
          target: "engine",
          specListFile: "packages/engine/Specs/SpecList.js",
          fileCount: 1,
          digest: "0123456789abcdef",
          files: { [ENGINE_SPEC]: hashSpecSource(SOURCE_TREE[ENGINE_SPEC]) },
        },
        undefined,
        2,
      )}\n`,
    );

    const stale = await checkSpecBundleFreshness("engine", { cwd });
    assert.equal(stale.fresh, false);
    assert.equal(stale.comparison.reason, "manifest-version");
    assert.deepEqual(stale.comparison.changedSources, []);
    assert.deepEqual(stale.comparison.addedSources, []);
    assert.equal(
      decideSpecLaneRebuild("engine", stale.comparison, null),
      "full",
    );

    const first = await ensureWithStampingHook("engine", cwd);
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].comparison.reason, "manifest-version");
    assert.equal(first.result.fresh, true);

    const second = await ensureWithStampingHook("engine", cwd);
    assert.equal(second.calls.length, 0, "stale once, then fresh");
    assert.equal(second.result.rebuilt, false);
  }));

// ---------------------------------------------------------------------------
// Lanes: each `gulp test` lane serves a spec bundle and other built
// directories (a Cesium output, the engine workers, the test workers), each
// with its own source record. A build vouches only for what it wrote.
// ---------------------------------------------------------------------------

const OUT_DEFAULT = "Build/CesiumUnminified";
const OUT_RELEASE = "Build/Cesium";
const OUT_VARIANT = "Build/CesiumWebGL";
const ALL_OUTPUTS = [OUT_DEFAULT, OUT_RELEASE];

/** The flavours the lanes serve: debug pragmas kept, or the release build's. */
const DEVELOPMENT = { variant: "dual", minify: false, removePragmas: false };
const RELEASE = { variant: "dual", minify: true, removePragmas: true };

/** The record a build of `directory` stamps, in the flavour that build writes. */
function outputRecordFor(directory) {
  return outputRecord(
    directory,
    directory === OUT_RELEASE ? RELEASE : DEVELOPMENT,
  );
}

/**
 * Simulates a build in the sandbox through the real stamping helper: `edit`
 * runs while it "builds", then it stamps only what it wrote: the given output
 * directories, plus the combined spec bundle and the test workers unless
 * `bundle` is false.
 */
async function simulateBuild(cwd, outputs, options = {}) {
  const records = [
    ...outputs.map((directory) => outputRecordFor(directory)),
    ...(options.bundle === false
      ? []
      : [specRecord("combined"), testWorkersRecord()]),
  ];
  await runStampedBuild(
    records,
    async () => {
      if (options.edit) {
        await options.edit();
      }
    },
    { cwd },
  );
  return computeSpecManifest("combined", { cwd });
}

/** Callbacks that really re-stamp the sandbox, and record how they were called. */
function makeHooks(cwd, options = {}) {
  const restamp = options.restamp ?? true;
  const calls = { full: [], narrow: [] };
  const contexts = { full: [], narrow: [] };
  const logs = [];
  return {
    calls,
    contexts,
    logs,
    options: {
      cwd,
      log: (message) => logs.push(message),
      full: async (laneKey, context) => {
        calls.full.push(laneKey);
        contexts.full.push(context);
        if (!restamp) {
          return;
        }
        if (laneKey === "combined") {
          await simulateBuild(cwd, [OUT_DEFAULT]);
        } else {
          await stampLane(cwd, laneKey);
        }
      },
      narrow: async (specTarget, context) => {
        calls.narrow.push(specTarget);
        contexts.narrow.push(context);
        if (restamp) {
          await stamp(cwd, specRecord(specTarget));
        }
      },
    },
  };
}

test("lanes: a default-lane build never vouches for the release lane's Build/Cesium", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, ALL_OUTPUTS);
    assert.equal(
      (await checkSpecLaneFreshness("combined", { cwd })).fresh,
      true,
    );
    assert.equal(
      (await checkSpecLaneFreshness("release", { cwd })).fresh,
      true,
    );

    // A default-lane build: edit, then re-stamp only the output it wrote and
    // the combined bundle.
    await writeAt(cwd, ENGINE_SOURCE, "export default 42;");
    await simulateBuild(cwd, [OUT_DEFAULT]);

    const defaultLane = await checkSpecLaneFreshness("combined", { cwd });
    assert.equal(defaultLane.fresh, true);
    assert.equal(defaultLane.decision, "none");

    const release = await checkSpecLaneFreshness("release", { cwd });
    assert.equal(release.fresh, false);
    assert.equal(release.decision, "refuse");
    assert.equal(release.spec.fresh, true, "the shared spec bundle is current");
    assert.deepEqual(release.output.comparison.changedSources, [ENGINE_SOURCE]);
    assert.ok(release.report.includes('Cesium output "Build/Cesium" is STALE'));
    assert.ok(release.report.includes(ENGINE_SOURCE), release.report);
    assert.ok(release.report.includes("npm run build-release"), release.report);
    assert.ok(!release.report.includes("npx gulp build"), release.report);

    const hooks = makeHooks(cwd);
    await assert.rejects(
      ensureSpecLaneFresh("release", hooks.options),
      (error) =>
        error.message.includes(ENGINE_SOURCE) &&
        error.message.includes("Build/Cesium") &&
        error.message.includes("npm run build-release") &&
        !error.message.includes("npx gulp build"),
    );
    assert.deepEqual(hooks.calls, { full: [], narrow: [] });
  }));

test("lanes: a release-only build never vouches for the default lane", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, ALL_OUTPUTS);
    await writeAt(cwd, ENGINE_SOURCE, "export default 43;");
    // A release-only (or --minify) build writes Build/Cesium and nothing else.
    await simulateBuild(cwd, [OUT_RELEASE], { bundle: false });

    const release = await checkSpecLaneFreshness("release", { cwd });
    assert.equal(release.output.comparison.fresh, true);

    const defaultLane = await checkSpecLaneFreshness("combined", { cwd });
    assert.equal(defaultLane.fresh, false);
    assert.equal(defaultLane.decision, "full");
    assert.deepEqual(defaultLane.output.comparison.changedSources, [
      ENGINE_SOURCE,
    ]);
    assert.ok(
      defaultLane.report.includes(
        'Cesium output "Build/CesiumUnminified" is STALE',
      ),
      defaultLane.report,
    );
    assert.ok(defaultLane.report.includes(ENGINE_SOURCE), defaultLane.report);
  }));

test("lanes: a record stamped for a variant directory never makes the default lane fresh", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, [OUT_VARIANT]);

    const missing = await checkSpecLaneFreshness("combined", { cwd });
    assert.equal(missing.fresh, false);
    assert.equal(missing.decision, "full");
    assert.equal(missing.output.comparison.reason, "manifest-missing");

    // Even the variant's record copied into the default directory is rejected.
    const record = await readFile(
      path.join(cwd, OUT_VARIANT, "SourceInputs.meta.json"),
      "utf8",
    );
    await writeAt(cwd, "Build/CesiumUnminified/SourceInputs.meta.json", record);
    const copied = await checkSpecLaneFreshness("combined", { cwd });
    assert.equal(copied.fresh, false);
    assert.equal(copied.decision, "full");
    assert.equal(copied.output.comparison.reason, "manifest-target-mismatch");
  }));

test("snapshot: a build stamps the inputs it read before it began, so an edit made while it runs is stale and named", () =>
  withSourceSandbox(async (cwd) => {
    await runStampedBuild(
      [
        outputRecordFor(OUT_DEFAULT),
        specRecord("combined"),
        testWorkersRecord(),
      ],
      async () => {
        // The build has read the source; the developer saves an edit.
        await writeAt(cwd, ENGINE_SOURCE, "export default 'edited mid-build';");
      },
      { cwd },
    );

    const stale = await checkSpecLaneFreshness("combined", { cwd });
    assert.equal(stale.fresh, false);
    assert.equal(stale.decision, "full");
    assert.deepEqual(stale.spec.comparison.changedSources, [ENGINE_SOURCE]);
    assert.deepEqual(stale.output.comparison.changedSources, [ENGINE_SOURCE]);
    assert.ok(stale.report.includes(ENGINE_SOURCE), stale.report);
  }));

test("snapshot: a build given a lane check's snapshot stamps it, and hashes only the inputs the snapshot lacks", () =>
  withSourceSandbox(async (cwd) => {
    const checked = await takeSourceSnapshot({
      cwd,
      groups: specRecord("engine").groups,
    });
    await writeAt(cwd, ENGINE_SOURCE, "export default 'after the check';");
    await runStampedBuild(
      [specRecord("engine"), engineWorkersRecord()],
      async () => {},
      { cwd, snapshot: checked },
    );
    const spec = await readRecord(specRecord("engine"), { cwd });
    assert.equal(
      spec.digest,
      deriveRecord(specRecord("engine"), checked).digest,
    );
    assert.equal(
      spec.sources[ENGINE_SOURCE],
      checked.groups.engineSource[ENGINE_SOURCE],
    );
    // The engine-workers groups were all in the snapshot too, so its record
    // also holds the checked hashes, and the lane reads the edit.
    const engine = await checkSpecLaneFreshness("engine", { cwd });
    assert.deepEqual(engine.spec.comparison.changedSources, [ENGINE_SOURCE]);
    assert.deepEqual(engine.records[0].comparison.changedSources, [
      ENGINE_SOURCE,
    ]);

    // A record cannot be derived from a snapshot that lacks its inputs.
    assert.throws(
      () => deriveRecord(outputRecordFor(OUT_DEFAULT), checked),
      /does not hold the "engineAssets" inputs/,
    );
  }));

test("snapshot: a build that writes and then fails, or is interrupted, leaves no record, so the lane stays stale after the sources return", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, ALL_OUTPUTS);
    assert.equal(
      (await checkSpecLaneFreshness("combined", { cwd })).fresh,
      true,
    );
    assert.equal(
      (await checkSpecLaneFreshness("release", { cwd })).fresh,
      true,
    );

    // A build of another branch's sources writes, then fails (or is stopped).
    const original = SOURCE_TREE[ENGINE_SOURCE];
    await writeAt(cwd, ENGINE_SOURCE, "export default 'feature branch';");
    await assert.rejects(
      runStampedBuild(
        [
          outputRecordFor(OUT_DEFAULT),
          specRecord("combined"),
          testWorkersRecord(),
        ],
        async () => {
          throw new Error("bundleTestWorkers failed");
        },
        { cwd },
      ),
      /bundleTestWorkers failed/,
    );
    for (const descriptor of [
      outputRecordFor(OUT_DEFAULT),
      specRecord("combined"),
      testWorkersRecord(),
    ]) {
      assert.equal(
        await readRecord(descriptor, { cwd }),
        null,
        descriptor.label,
      );
    }

    // Back on the old sources: the records that described them are gone, so
    // neither lane that served the failed build's bytes reads fresh.
    await writeAt(cwd, ENGINE_SOURCE, original);
    const combined = await checkSpecLaneFreshness("combined", { cwd });
    assert.equal(combined.decision, "full");
    assert.equal(combined.output.comparison.reason, "manifest-missing");
    const release = await checkSpecLaneFreshness("release", { cwd });
    assert.equal(release.decision, "refuse");
    assert.equal(release.spec.comparison.reason, "manifest-missing");
  }));

test("snapshot: a watch build, which rewrites without stamping, removes the records of what it will rewrite", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, ALL_OUTPUTS);
    await runStampedBuild(
      [
        outputRecordFor(OUT_DEFAULT),
        specRecord("combined"),
        testWorkersRecord(),
      ],
      async () => {},
      { cwd, stamp: false },
    );
    // The watch rewrites a spec, the developer undoes it later: the lanes
    // that serve its bundle must not read fresh.
    const release = await checkSpecLaneFreshness("release", { cwd });
    assert.equal(release.decision, "refuse");
    assert.equal(release.spec.comparison.reason, "manifest-missing");
    assert.equal(
      (await checkSpecLaneFreshness("combined", { cwd })).decision,
      "full",
    );
    assert.equal(
      await readRecord(outputRecordFor(OUT_RELEASE), { cwd }).then(
        (record) => record?.directory,
      ),
      OUT_RELEASE,
      "a record the watch build does not cover is kept",
    );
  }));

test("hook: combined-lane source or helper drift runs the full build once; spec-only drift runs the narrow one", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, ALL_OUTPUTS);

    await writeAt(cwd, ENGINE_SOURCE, "export default 50;");
    const source = makeHooks(cwd);
    const first = await ensureSpecLaneFresh("combined", source.options);
    assert.deepEqual(source.calls, { full: ["combined"], narrow: [] });
    assert.equal(first.rebuilt, true);
    assert.equal(first.ranDecision, "full");
    assert.equal(first.fresh, true);
    const sourceLog = source.logs.join("|");
    assert.ok(sourceLog.includes("full build"), sourceLog);
    assert.ok(sourceLog.includes(ENGINE_SOURCE), sourceLog);

    // Spec-only drift with the output current: only the spec bundle rebuilds.
    await writeAt(cwd, ENGINE_SPEC, "describe('Alpha again', () => {});");
    const spec = makeHooks(cwd);
    const second = await ensureSpecLaneFresh("combined", spec.options);
    assert.deepEqual(spec.calls, { full: [], narrow: ["combined"] });
    assert.equal(second.ranDecision, "narrow");
    const specLog = spec.logs.join("|");
    assert.ok(specLog.includes("spec bundle only"), specLog);
    assert.ok(specLog.includes(ENGINE_SPEC), specLog);

    // A Specs helper is no input of the output, but it is source the bundle
    // inlines: only the full build is trusted to refresh what the bundle
    // inlines, so the output being current does not make it narrow.
    await writeAt(cwd, ROOT_HELPER, "export default function again() {}");
    const helper = makeHooks(cwd);
    await ensureSpecLaneFresh("combined", helper.options);
    assert.deepEqual(helper.calls, { full: ["combined"], narrow: [] });
  }));

test("hook: workspace lanes run the workspace build for source drift and the narrow one for spec-only drift", () =>
  withSourceSandbox(async (cwd) => {
    await stampLane(cwd, "engine");

    await writeAt(cwd, ENGINE_SOURCE, "export default 60;");
    const source = makeHooks(cwd);
    await ensureSpecLaneFresh("engine", source.options);
    assert.deepEqual(source.calls, { full: ["engine"], narrow: [] });

    await writeAt(cwd, ENGINE_SPEC, "describe('Alpha third', () => {});");
    const spec = makeHooks(cwd);
    const result = await ensureSpecLaneFresh("engine", spec.options);
    assert.deepEqual(spec.calls, { full: [], narrow: ["engine"] });
    assert.equal(result.ranDecision, "narrow");

    // Each build is handed the snapshot the check took, so it stamps the
    // inputs the check compared.
    for (const context of [...source.contexts.full, ...spec.contexts.narrow]) {
      assert.equal(context.snapshot.version, SPEC_MANIFEST_VERSION);
      assert.ok(context.snapshot.groups.engineSpecs, "the checked spec inputs");
    }
    assert.equal(
      spec.contexts.narrow[0].snapshot.groups.engineSpecs[ENGINE_SPEC],
      hashSpecSource("describe('Alpha third', () => {});"),
    );
  }));

test("hook: a fresh lane runs neither build; a refusal runs neither and rejects; a build that does not restamp rejects", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, [OUT_DEFAULT]);
    await stampLane(cwd, "engine");

    for (const lane of ["combined", "engine"]) {
      const fresh = makeHooks(cwd);
      const result = await ensureSpecLaneFresh(lane, fresh.options);
      assert.deepEqual(fresh.calls, { full: [], narrow: [] }, lane);
      assert.equal(result.rebuilt, false, lane);
      assert.equal(result.ranDecision, "none", lane);
    }

    // Build/Cesium was never built: the release lane refuses.
    const refused = makeHooks(cwd);
    await assert.rejects(
      ensureSpecLaneFresh("release", refused.options),
      /does not build Build\/Cesium/,
    );
    assert.deepEqual(refused.calls, { full: [], narrow: [] });

    // No callback at all: staleness is fatal.
    await writeAt(cwd, ENGINE_SOURCE, "export default 70;");
    await assert.rejects(ensureSpecLaneFresh("combined", { cwd }), /STALE/);

    const lazy = makeHooks(cwd, { restamp: false });
    await assert.rejects(
      ensureSpecLaneFresh("combined", lazy.options),
      /did not make the lane fresh/,
    );
    assert.deepEqual(lazy.calls, { full: ["combined"], narrow: [] });
  }));

test("sources: .ts and .wgsl edits make the lane stale and are named", async () => {
  for (const file of [ENGINE_TS, ENGINE_WGSL]) {
    await withSourceSandbox(async (cwd) => {
      await simulateBuild(cwd, ALL_OUTPUTS);
      assert.equal(
        (await checkSpecLaneFreshness("combined", { cwd })).fresh,
        true,
      );

      await writeAt(cwd, file, "// edited");
      const stale = await checkSpecLaneFreshness("combined", { cwd });
      assert.equal(stale.fresh, false, file);
      assert.equal(stale.decision, "full", file);
      assert.deepEqual(stale.spec.comparison.changedSources, [file]);
      assert.deepEqual(stale.output.comparison.changedSources, [file]);
      assert.ok(stale.report.includes(file), stale.report);

      // A new file of either kind is named too.
      await simulateBuild(cwd, ALL_OUTPUTS);
      const added = file
        .replace("Thing.", "Added.")
        .replace("Typed.", "Added.");
      await writeAt(cwd, added, "// new");
      const grown = await checkSpecLaneFreshness("combined", { cwd });
      assert.deepEqual(grown.output.comparison.addedSources, [added]);
    });
  }
});

test("sources: generated shader modules are not inputs; the files copied out of node_modules are", () =>
  withSourceSandbox(async (cwd) => {
    const manifest = await simulateBuild(cwd, ALL_OUTPUTS);
    await stampLane(cwd, "engine");
    assert.ok(!(ENGINE_GENERATED_SHADER in manifest.sources));
    assert.ok(ENGINE_WGSL in manifest.sources, "the .wgsl beside it is hashed");

    // A build rewrites the generated modules (their bytes depend on the minify
    // flag) after its snapshot, so they are not inputs.
    await writeAt(cwd, ENGINE_GENERATED_SHADER, "export default 'minified';");
    await writeAt(cwd, "packages/engine/Source/Shaders/Added.js", "// gen");
    await writeAt(
      cwd,
      "packages/engine/Source/ThirdParty/Shaders/X.js",
      "// gen",
    );
    for (const lane of ["combined", "release", "engine"]) {
      const result = await checkSpecLaneFreshness(lane, { cwd });
      assert.equal(result.fresh, true, lane);
    }

    // `npm run prepare` copies third-party files out of node_modules into
    // Source; the builds copy or bundle them into what the lanes serve.
    await writeAt(cwd, COPIED_THIRD_PARTY, "// copied");
    for (const lane of ["combined", "release", "engine"]) {
      const result = await checkSpecLaneFreshness(lane, { cwd });
      assert.equal(result.fresh, false, lane);
      assert.ok(result.report.includes(COPIED_THIRD_PARTY), result.report);
    }
  }));

test("sources: a .wasm-only change makes every lane that serves it stale", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, ALL_OUTPUTS);
    await stampLane(cwd, "engine");
    // A rebuilt kernel: the tracked binary changes, its glue does not.
    await writeAt(cwd, ENGINE_WASM, "\0asm\u0001\0\0\u0001");
    for (const lane of ["combined", "release"]) {
      const stale = await checkSpecLaneFreshness(lane, { cwd });
      assert.notEqual(stale.decision, "none", lane);
      assert.deepEqual(stale.output.comparison.changedSources, [ENGINE_WASM]);
      assert.ok(stale.report.includes(ENGINE_WASM), stale.report);
    }
    const engine = await checkSpecLaneFreshness("engine", { cwd });
    assert.equal(engine.decision, "full");
    assert.deepEqual(engine.records[0].comparison.changedSources, [
      ENGINE_WASM,
    ]);
  }));

test("sources: a build-tooling change makes every lane stale", async () => {
  for (const tool of [BUILD_SCRIPT, "gulpfile.js"]) {
    await withSourceSandbox(async (cwd) => {
      await simulateBuild(cwd, ALL_OUTPUTS);
      for (const laneKey of ["engine", "widgets"]) {
        await stampLane(cwd, laneKey);
      }
      await writeAt(cwd, tool, "// the build now writes different bytes\n");
      for (const laneKey of Object.keys(specTestLanes)) {
        const stale = await checkSpecLaneFreshness(laneKey, { cwd });
        assert.notEqual(stale.decision, "none", `${tool} ${laneKey}`);
        assert.ok(stale.report.includes(tool), stale.report);
        for (const check of stale.records) {
          assert.deepEqual(check.comparison.changedSources, [tool], laneKey);
        }
      }
    });
  }
});

test("lanes: a widgets-only build never vouches for the engine workers the widgets lane serves", () =>
  withSourceSandbox(async (cwd) => {
    await stampLane(cwd, "widgets");
    assert.equal(
      (await checkSpecLaneFreshness("widgets", { cwd })).fresh,
      true,
    );

    // An engine edit, then what `npm run build --workspace @cesium/widgets`
    // stamps: the widgets spec bundle alone.
    await writeAt(cwd, ENGINE_SOURCE, "export default 'engine edit';");
    await stamp(cwd, specRecord("widgets"));

    const widgets = await checkSpecLaneFreshness("widgets", { cwd });
    assert.equal(widgets.spec.fresh, true);
    assert.equal(widgets.decision, "full", "never narrow, never none");
    const workers = widgets.records.find(
      (check) => check.descriptor.kind === "engine-workers",
    );
    assert.deepEqual(workers.comparison.changedSources, [ENGINE_SOURCE]);
    assert.ok(
      widgets.report.includes(
        'Engine workers "packages/engine/Build/Workers" is STALE',
      ),
      widgets.report,
    );
  }));

test("lanes: the test workers every lane serves are checked by every lane", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, ALL_OUTPUTS);
    for (const laneKey of ["engine", "widgets"]) {
      await stampLane(cwd, laneKey);
    }
    await writeAt(cwd, TEST_WORKER, "export default function edited() {}\n");
    const expected = {
      combined: "full",
      release: "refuse",
      engine: "full",
      widgets: "full",
    };
    for (const [laneKey, decision] of Object.entries(expected)) {
      const result = await checkSpecLaneFreshness(laneKey, { cwd });
      assert.equal(
        result.spec.fresh,
        true,
        `${laneKey}: no spec bundle inlines it`,
      );
      assert.equal(result.decision, decision, laneKey);
      const workers = result.records.find(
        (check) => check.descriptor.kind === "test-workers",
      );
      assert.deepEqual(workers.comparison.changedSources, [TEST_WORKER]);
    }
  }));

test("lanes: an output of another flavour never vouches for the lane that serves it", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, ALL_OUTPUTS);
    // `gulp build --minify` writes a current Build/Cesium that keeps the debug
    // pragmas; `gulp build --removePragmas` strips them from the default one.
    await stamp(
      cwd,
      outputRecord(OUT_RELEASE, { minify: true, removePragmas: false }),
      outputRecord(OUT_DEFAULT, { minify: false, removePragmas: true }),
    );
    const release = await checkSpecLaneFreshness("release", { cwd });
    assert.equal(release.decision, "refuse");
    assert.equal(release.output.comparison.reason, "flavour-mismatch");
    assert.deepEqual(release.output.comparison.recordedFlavour, {
      variant: "dual",
      minify: true,
      removePragmas: false,
    });
    assert.ok(release.report.includes("removePragmas=false"), release.report);
    assert.ok(release.report.includes("npm run build-release"), release.report);
    const combined = await checkSpecLaneFreshness("combined", { cwd });
    assert.equal(combined.decision, "full");
    assert.equal(combined.output.comparison.reason, "flavour-mismatch");

    // The engine workers of a minified or pragma-stripped engine build too.
    await stampLane(cwd, "engine");
    await stamp(cwd, engineWorkersRecord({ minify: true }));
    const engine = await checkSpecLaneFreshness("engine", { cwd });
    assert.equal(engine.decision, "full");
    assert.equal(engine.records[0].comparison.reason, "flavour-mismatch");
  }));

test("sources: third-party pins (package manifests and the installed-tree record) make every lane stale", async () => {
  for (const pin of [
    LOCK_PIN,
    ENGINE_PIN,
    "package.json",
    "packages/widgets/package.json",
  ]) {
    await withSourceSandbox(async (cwd) => {
      await simulateBuild(cwd, ALL_OUTPUTS);
      await stampLane(cwd, "engine");
      await writeAt(cwd, pin, '{"changed":true}');

      for (const lane of ["combined", "release"]) {
        const stale = await checkSpecLaneFreshness(lane, { cwd });
        assert.equal(stale.fresh, false, pin);
        assert.deepEqual(stale.spec.comparison.changedSources, [pin], pin);
        assert.deepEqual(stale.output.comparison.changedSources, [pin], pin);
        assert.ok(stale.report.includes(pin), stale.report);
      }
      const engine = await checkSpecLaneFreshness("engine", { cwd });
      assert.equal(engine.fresh, false, pin);
      assert.deepEqual(engine.spec.comparison.changedSources, [pin], pin);
    });
  }
});

test("lanes: gulp test's arguments resolve to the lane they serve", () => {
  assert.equal(
    resolveSpecTestLane({ workspace: "engine", release: true }),
    "release",
  );
  assert.equal(resolveSpecTestLane({ release: true }), "release");
  assert.equal(resolveSpecTestLane({ workspace: "engine" }), "engine");
  assert.equal(resolveSpecTestLane({ workspace: "widgets" }), "widgets");
  assert.equal(resolveSpecTestLane({}), "combined");
});

test("routing: missing and foreign manifests need the full build; fresh needs none; release refuses", () => {
  const current = buildSpecManifest("engine", [
    { path: "a/AlphaSpec.js", contents: "one" },
  ]);
  assert.equal(
    decideSpecLaneRebuild("engine", compareSpecManifests(current, null), null),
    "full",
  );
  assert.equal(
    decideSpecLaneRebuild(
      "engine",
      compareSpecManifests(current, { ...current, target: "widgets" }),
      null,
    ),
    "full",
  );
  assert.equal(
    decideSpecLaneRebuild(
      "engine",
      compareSpecManifests(current, current),
      FRESH_WORKSPACE_RECORDS,
    ),
    "none",
  );
  // A lane given no comparison for a record it reads is never current.
  assert.equal(
    decideSpecLaneRebuild(
      "engine",
      compareSpecManifests(current, current),
      FRESH_WORKSPACE_RECORDS.slice(1),
    ),
    "full",
  );
  assert.equal(
    decideSpecLaneRebuild("release", compareSpecManifests(current, null), null),
    "refuse",
  );

  // With the served output and test workers current, only spec drift is
  // narrow; source drift in the bundle needs the full build, or a refusal in
  // the release lane.
  const freshOutput = [
    { fresh: true, reason: "fresh" },
    { fresh: true, reason: "fresh" },
  ];
  const combinedBase = buildSpecManifest(
    "combined",
    [{ path: "a/AlphaSpec.js", contents: "one" }],
    [{ path: "packages/engine/Source/A.ts", hash: "1" }],
  );
  const specDrift = compareSpecManifests(
    buildSpecManifest(
      "combined",
      [{ path: "a/AlphaSpec.js", contents: "two" }],
      [{ path: "packages/engine/Source/A.ts", hash: "1" }],
    ),
    combinedBase,
  );
  const sourceDrift = compareSpecManifests(
    buildSpecManifest(
      "combined",
      [{ path: "a/AlphaSpec.js", contents: "one" }],
      [{ path: "packages/engine/Source/A.ts", hash: "2" }],
    ),
    combinedBase,
  );
  assert.equal(
    decideSpecLaneRebuild("combined", specDrift, freshOutput),
    "narrow",
  );
  assert.equal(
    decideSpecLaneRebuild("release", specDrift, freshOutput),
    "narrow",
  );
  assert.equal(
    decideSpecLaneRebuild("combined", sourceDrift, freshOutput),
    "full",
  );
  assert.equal(
    decideSpecLaneRebuild("release", sourceDrift, freshOutput),
    "refuse",
  );
});

test("routing: the release lane refuses stale source and narrows spec-only drift", () =>
  withSourceSandbox(async (cwd) => {
    await simulateBuild(cwd, ALL_OUTPUTS);

    await writeAt(cwd, WIDGETS_SPEC, "describe('Viewer edited', () => {});");
    const specOnly = await checkSpecLaneFreshness("release", { cwd });
    assert.equal(specOnly.decision, "narrow");

    await writeAt(cwd, ENGINE_SOURCE, "export default 5;");
    const both = await checkSpecLaneFreshness("release", { cwd });
    assert.equal(both.decision, "refuse");
    assert.equal(
      (await checkSpecLaneFreshness("combined", { cwd })).decision,
      "full",
    );

    const hooks = makeHooks(cwd);
    await assert.rejects(
      ensureSpecLaneFresh("release", hooks.options),
      (error) => error.message.includes(ENGINE_SOURCE),
    );
    assert.deepEqual(hooks.calls, { full: [], narrow: [] });
  }));

test("old records: v1 and v2 spec manifests are manifest-version; a missing output record is rebuilt once, then stays fresh", () =>
  withSourceSandbox(async (cwd) => {
    const bundleRecord = path.join("Build/Specs", SPEC_MANIFEST_FILENAME);
    for (const version of [1, 2]) {
      await writeAt(
        cwd,
        bundleRecord,
        JSON.stringify({
          version,
          target: "combined",
          specListFile: "Specs/SpecList.js",
          fileCount: 1,
          digest: "0123456789abcdef",
          files: { [ENGINE_SPEC]: hashSpecSource(SOURCE_TREE[ENGINE_SPEC]) },
          ...(version === 2 ? { sourceCount: 0, sources: {} } : {}),
        }),
      );
      const stale = await checkSpecLaneFreshness("combined", { cwd });
      assert.equal(stale.spec.comparison.reason, "manifest-version", version);
      assert.equal(stale.fresh, false);
    }

    // A current bundle with no output record: full for the default lane,
    // refuse for the release lane.
    await simulateBuild(cwd, []);
    const defaultLane = await checkSpecLaneFreshness("combined", { cwd });
    assert.equal(defaultLane.spec.fresh, true);
    assert.equal(defaultLane.output.comparison.reason, "manifest-missing");
    assert.equal(defaultLane.decision, "full");
    assert.equal(
      (await checkSpecLaneFreshness("release", { cwd })).decision,
      "refuse",
    );

    const once = makeHooks(cwd);
    const rebuilt = await ensureSpecLaneFresh("combined", once.options);
    assert.deepEqual(once.calls, { full: ["combined"], narrow: [] });
    assert.equal(rebuilt.fresh, true);

    const twice = makeHooks(cwd);
    const again = await ensureSpecLaneFresh("combined", twice.options);
    assert.deepEqual(twice.calls, { full: [], narrow: [] });
    assert.equal(again.rebuilt, false);
  }));

// ---------------------------------------------------------------------------
// The `gulp test` plan: the lane its arguments select, the builds it runs and
// the files Karma serves (scripts/specTestLanePlan.js).
// ---------------------------------------------------------------------------

/** Build functions that record how the plan calls them. */
function fakeBuilds() {
  const calls = [];
  const record =
    (name) =>
    async (...args) => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    builds: {
      buildEngine: record("buildEngine"),
      buildWidgets: record("buildWidgets"),
      buildCesium: record("buildCesium"),
      buildTestWorkers: record("buildTestWorkers"),
      buildCombinedSpecBundle: record("buildCombinedSpecBundle"),
      buildWorkspaceSpecBundle: record("buildWorkspaceSpecBundle"),
    },
  };
}

test("plan: --release serves and checks Build/Cesium, whatever --workspace says, and has no full build", () => {
  const { builds } = fakeBuilds();
  for (const argv of [
    { release: true },
    { release: true, workspace: "@cesium/engine" },
    { release: true, workspace: "widgets" },
  ]) {
    const plan = planSpecTestLane(argv, builds);
    assert.equal(plan.lane, "release", JSON.stringify(argv));
    assert.equal(plan.full, undefined);
    const included = plan.files.filter((file) => file.included);
    assert.ok(
      included.some((file) => file.pattern === "Build/Cesium/Cesium.js"),
      JSON.stringify(plan.files),
    );
    assert.ok(
      !plan.files.some((file) => file.pattern.includes("CesiumUnminified")),
    );
  }
  assert.equal(planSpecTestLane({}, builds).lane, "combined");
  assert.equal(
    planSpecTestLane({ workspace: "@cesium/widgets" }, builds).lane,
    "widgets",
  );
  assert.equal(
    planSpecTestLane({ workspace: "engine" }, builds).lane,
    "engine",
  );
});

test("plan: every built directory Karma serves has a record the lane checks", () => {
  const { builds } = fakeBuilds();
  for (const laneKey of Object.keys(specTestLanes)) {
    const lane = getSpecTestLane(laneKey);
    const checked = [specRecord(lane.specTarget), ...lane.records].map(
      (descriptor) => `${descriptor.directory}/`,
    );
    const argv =
      laneKey === "release"
        ? { release: true }
        : laneKey === "combined"
          ? {}
          : { workspace: laneKey };
    const plan = planSpecTestLane(argv, builds);
    assert.deepEqual(plan.files, karmaFilesForLane(laneKey).files);
    const servedBuilt = [
      ...plan.files.map((file) => file.pattern),
      ...Object.values(plan.proxies ?? {}).map((target) =>
        target.replace(/^\/base\//, ""),
      ),
    ].filter((pattern) => /^(Build|packages\/[^/]+\/Build)\//.test(pattern));
    assert.ok(servedBuilt.length > 0, laneKey);
    for (const pattern of servedBuilt) {
      assert.ok(
        checked.some((directory) => pattern.startsWith(directory)),
        `${laneKey} serves ${pattern}, which no record it checks covers (${checked.join(", ")})`,
      );
    }
  }
});

test("plan: each lane's full build runs the builds that write what it serves, and both builds pass the check's snapshot", async () => {
  const snapshot = { version: SPEC_MANIFEST_VERSION, groups: {} };
  const expected = {
    combined: [
      ["buildEngine", { snapshot }],
      ["buildWidgets", { snapshot }],
      ["buildCesium", { iife: true, clean: false, snapshot }],
    ],
    engine: [
      ["buildEngine", { snapshot }],
      ["buildTestWorkers", { snapshot }],
    ],
    widgets: [
      ["buildEngine", { snapshot }],
      ["buildWidgets", { snapshot }],
      ["buildTestWorkers", { snapshot }],
    ],
  };
  for (const [laneKey, calls] of Object.entries(expected)) {
    const fake = fakeBuilds();
    const plan = planSpecTestLane(
      laneKey === "combined" ? {} : { workspace: laneKey },
      fake.builds,
    );
    await plan.full(laneKey, { snapshot });
    assert.deepEqual(fake.calls, calls, laneKey);

    const narrow = fakeBuilds();
    await planSpecTestLane(
      laneKey === "combined" ? {} : { workspace: laneKey },
      narrow.builds,
    ).narrow(laneKey, { snapshot });
    assert.deepEqual(
      narrow.calls,
      laneKey === "combined"
        ? [["buildCombinedSpecBundle", { snapshot }]]
        : [["buildWorkspaceSpecBundle", laneKey, { snapshot }]],
      laneKey,
    );
  }
  const release = fakeBuilds();
  await planSpecTestLane({ release: true }, release.builds).narrow("combined", {
    snapshot,
  });
  assert.deepEqual(release.calls, [["buildCombinedSpecBundle", { snapshot }]]);

  // The up-front build of the non-production path passes no snapshot: each
  // build then takes its own.
  const upFront = fakeBuilds();
  await planSpecTestLane({}, upFront.builds).full();
  assert.deepEqual(upFront.calls[2], [
    "buildCesium",
    { iife: true, clean: false, snapshot: undefined },
  ]);
});

test("plan: the handshake gulp test runs checks the plan's own lane, and rebuilds it with the plan's own builds", () =>
  withSourceSandbox(async (cwd) => {
    const everyRecord = [
      ...new Map(
        Object.values(specTestLanes)
          .flatMap((lane) => [specRecord(lane.specTarget), ...lane.records])
          .map((descriptor) => [recordPath(descriptor, { cwd }), descriptor]),
      ).values(),
    ];
    const clearRecords = () =>
      runStampedBuild(everyRecord, async () => {}, { cwd, stamp: false });
    const argvFor = (laneKey) =>
      laneKey === "release"
        ? { release: true }
        : laneKey === "combined"
          ? {}
          : { workspace: `@cesium/${laneKey}` };

    for (const laneKey of Object.keys(specTestLanes)) {
      // Only this lane's records are current, and every other lane reads a
      // record this one does not: a handshake that checked any other lane
      // would rebuild, refuse or throw.
      await clearRecords();
      await stampLane(cwd, laneKey);
      for (const other of Object.keys(specTestLanes)) {
        if (other !== laneKey) {
          assert.notEqual(
            (await checkSpecLaneFreshness(other, { cwd })).decision,
            "none",
            `${other} with only the ${laneKey} lane stamped`,
          );
        }
      }
      const fake = fakeBuilds();
      const result = await planSpecTestLane(
        argvFor(laneKey),
        fake.builds,
      ).ensureFresh({ cwd });
      assert.equal(result.lane, laneKey);
      assert.equal(result.fresh, true, laneKey);
      assert.equal(result.rebuilt, false, laneKey);
      assert.deepEqual(fake.calls, [], laneKey);
    }

    // A stale lane runs the plan's full build, not one the caller passes, with
    // the snapshot the check took.
    await clearRecords();
    const calls = [];
    const logs = [];
    const builds = {
      ...fakeBuilds().builds,
      buildEngine: async (options) => {
        calls.push(["buildEngine", options]);
      },
      buildTestWorkers: async (options) => {
        calls.push(["buildTestWorkers", options]);
        await stampLane(cwd, "engine");
      },
    };
    const result = await planSpecTestLane(
      argvFor("engine"),
      builds,
    ).ensureFresh({
      cwd,
      log: (message) => logs.push(message),
      full: async () => assert.fail("the caller's full build ran"),
    });
    assert.equal(result.lane, "engine");
    assert.equal(result.rebuilt, true);
    assert.equal(result.ranDecision, "full");
    assert.deepEqual(
      calls.map(([name]) => name),
      ["buildEngine", "buildTestWorkers"],
    );
    assert.equal(typeof calls[0][1].snapshot?.groups, "object");
    assert.ok(
      logs.some((message) => message.includes("full build")),
      logs.join("\n"),
    );

    // The release lane refuses with its own directory, whatever is current in
    // the default lane.
    await clearRecords();
    await stampLane(cwd, "combined");
    await assert.rejects(
      planSpecTestLane(argvFor("release"), fakeBuilds().builds).ensureFresh({
        cwd,
      }),
      /does not build Build\/Cesium;/,
    );
  }));

test("records: each record sits in the directory it vouches for", () => {
  assert.equal(
    recordPath(specRecord("combined"), { cwd: "/r" }),
    path.resolve("/r", "Build/Specs", SPEC_MANIFEST_FILENAME),
  );
  assert.equal(
    recordPath(outputRecord(OUT_RELEASE), { cwd: "/r" }),
    path.resolve("/r", OUT_RELEASE, "SourceInputs.meta.json"),
  );
  assert.equal(
    recordPath(engineWorkersRecord(), { cwd: "/r" }),
    path.resolve(
      "/r",
      "packages/engine/Build/Workers",
      "SourceInputs.meta.json",
    ),
  );
  assert.equal(
    recordPath(testWorkersRecord(), { cwd: "/r" }),
    path.resolve("/r", "Build/Specs/TestWorkers", "SourceInputs.meta.json"),
  );
});

// runStampedBuild, the one helper every rewrite and every build goes through,
// against a temporary directory with records placed by hand and a `build` that
// looks at them. The cases run for a call that stamps and for one that does
// not ({ stamp: false }, what the watch's rewrites pass).
const STAMP_MODES = [
  { name: "stamp: false", options: { stamp: false } },
  { name: "stamping", options: {} },
];

const threeRecords = () => [
  outputRecordFor(OUT_DEFAULT),
  specRecord("combined"),
  testWorkersRecord(),
];

/** The labels of the records that exist, through `stat`, so a directory counts. */
async function labelsPresent(cwd, descriptors) {
  const found = [];
  for (const descriptor of descriptors) {
    try {
      await stat(recordPath(descriptor, { cwd }));
      found.push(descriptor.label);
    } catch {
      // absent
    }
  }
  return found;
}

/** Places every record the way a build does: by stamping them. */
async function placeRecords(cwd) {
  await stamp(cwd, ...threeRecords());
  assert.deepEqual(
    await labelsPresent(cwd, threeRecords()),
    threeRecords().map((descriptor) => descriptor.label),
    "the records were placed",
  );
}

test("runStampedBuild: every record is gone when build starts, whether or not the call stamps", () =>
  withSourceSandbox(async (cwd) => {
    for (const mode of STAMP_MODES) {
      await placeRecords(cwd);
      let seen = null;
      await runStampedBuild(
        threeRecords(),
        async () => {
          seen = await labelsPresent(cwd, threeRecords());
        },
        { cwd, ...mode.options },
      );
      assert.deepEqual(seen, [], `${mode.name}: records the build saw`);
    }
  }));

test("runStampedBuild: a record whose path cannot be removed rejects the call and build is never called, whether or not the call stamps", () =>
  withSourceSandbox(async (cwd) => {
    for (const mode of STAMP_MODES) {
      await placeRecords(cwd);
      // A directory where the output record's file was: `rm` cannot remove it.
      const blocked = recordPath(outputRecordFor(OUT_DEFAULT), { cwd });
      await rm(blocked, { force: true });
      await mkdir(blocked, { recursive: true });
      let calls = 0;
      await assert.rejects(
        runStampedBuild(
          threeRecords(),
          async () => {
            calls += 1;
          },
          { cwd, ...mode.options },
        ),
        /EISDIR|directory/i,
        `${mode.name}: the call rejected`,
      );
      assert.equal(calls, 0, `${mode.name}: build was called`);
      assert.equal(
        (await stat(blocked)).isDirectory(),
        true,
        `${mode.name}: nothing was written where the record is`,
      );
      await rm(blocked, { recursive: true, force: true });
    }
  }));

test("runStampedBuild: three calls in a row, the second with a build that throws, each find the records placed before it gone, whether or not the call stamps", () =>
  withSourceSandbox(async (cwd) => {
    for (const mode of STAMP_MODES) {
      const seen = [];
      const look = async () => {
        seen.push(await labelsPresent(cwd, threeRecords()));
      };
      await placeRecords(cwd);
      await runStampedBuild(threeRecords(), look, { cwd, ...mode.options });
      await placeRecords(cwd);
      await assert.rejects(
        runStampedBuild(
          threeRecords(),
          async () => {
            await look();
            throw new Error("the second build failed");
          },
          { cwd, ...mode.options },
        ),
        /the second build failed/,
      );
      await placeRecords(cwd);
      await runStampedBuild(threeRecords(), look, { cwd, ...mode.options });
      assert.deepEqual(
        seen,
        [[], [], []],
        `${mode.name}: records each build saw`,
      );
    }
  }));

test("runStampedBuild: a build that throws leaves no record, whether or not the call stamps", () =>
  withSourceSandbox(async (cwd) => {
    for (const mode of STAMP_MODES) {
      await placeRecords(cwd);
      await assert.rejects(
        runStampedBuild(
          threeRecords(),
          async () => {
            throw new Error("the build failed");
          },
          { cwd, ...mode.options },
        ),
        /the build failed/,
      );
      assert.deepEqual(
        await labelsPresent(cwd, threeRecords()),
        [],
        `${mode.name}: records left after a failure`,
      );
    }
  }));

test("runStampedBuild: { stamp: false } writes no record after a build that succeeds, and a stamping call writes all of them", () =>
  withSourceSandbox(async (cwd) => {
    await placeRecords(cwd);
    await runStampedBuild(threeRecords(), async () => {}, {
      cwd,
      stamp: false,
    });
    assert.deepEqual(
      await labelsPresent(cwd, threeRecords()),
      [],
      "records left after a build that does not stamp",
    );
    await runStampedBuild(threeRecords(), async () => {}, { cwd });
    assert.deepEqual(
      await labelsPresent(cwd, threeRecords()),
      threeRecords().map((descriptor) => descriptor.label),
      "records after a build that stamps",
    );
  }));

test("runStampedBuild: two calls in flight at once each remove the records before their own build, whether or not the call stamps", () =>
  withSourceSandbox(async (cwd) => {
    for (const mode of STAMP_MODES) {
      // Started together: each build sees none.
      await placeRecords(cwd);
      const together = [];
      const look = async () => {
        together.push(await labelsPresent(cwd, threeRecords()));
      };
      await Promise.all([
        runStampedBuild(threeRecords(), look, { cwd, ...mode.options }),
        runStampedBuild(threeRecords(), look, { cwd, ...mode.options }),
      ]);
      assert.deepEqual(together, [[], []], `${mode.name}: started together`);

      // One in flight while the records are placed again: the second call
      // removes them before its own build, and so does the first call.
      await placeRecords(cwd);
      let started;
      const hasStarted = new Promise((resolve) => {
        started = resolve;
      });
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const first = [];
      const second = [];
      const firstCall = runStampedBuild(
        threeRecords(),
        async () => {
          first.push(await labelsPresent(cwd, threeRecords()));
          started();
          await gate;
        },
        { cwd, ...mode.options },
      );
      await hasStarted;
      await placeRecords(cwd);
      await runStampedBuild(
        threeRecords(),
        async () => {
          second.push(await labelsPresent(cwd, threeRecords()));
        },
        { cwd, ...mode.options },
      );
      release();
      await firstCall;
      assert.deepEqual(first, [[]], `${mode.name}: the call in flight`);
      assert.deepEqual(second, [[]], `${mode.name}: the call started later`);
    }
  }));
