// Spec-bundle freshness, the write side. The REAL build functions of
// scripts/build.js, and the real `gulp test` plan of scripts/specTestLanePlan.js,
// run in a throwaway repository under the lane temp root; the real freshness
// module then reads the records they left. Each test is a sequence a developer
// can run, and asserts that a lane reads fresh only when the bytes it serves
// were built from the sources on disk.
// @purpose Coverage of what the builds stamp: a build vouches only for the directories it wrote, from inputs hashed before it read them, and never after a failure, a watch rewrite or a shader edit it did not bundle.
// @status ACTIVE
//
// The builds run in a child process whose working directory is the sandbox:
// esbuild fixes its working directory when it is first imported, so the
// builds cannot run in this process after a chdir.
//
// Run: node --test scripts/__tests__/specBundleFreshnessBuilds.spec.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mkLaneTmp, removeLaneTmp } from "../../Tools/lib/lane-tmp.mjs";
import {
  checkRecord,
  checkSpecLaneFreshness,
  engineWorkersRecord,
  outputRecord,
  recordPath,
  specRecord,
  takeSourceSnapshot,
  testWorkersRecord,
} from "../specBundleFreshness.js";

const SCRIPTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BUILD_MODULE = pathToFileURL(path.join(SCRIPTS, "build.js")).href;
const PLAN_MODULE = pathToFileURL(
  path.join(SCRIPTS, "specTestLanePlan.js"),
).href;
const FRESHNESS_MODULE = pathToFileURL(
  path.join(SCRIPTS, "specBundleFreshness.js"),
).href;

const MARK = {
  engine: "packages/engine/Source/Core/Marker.js",
  glsl: "packages/engine/Source/Shaders/MarkerFS.glsl",
  glslModule: "packages/engine/Source/Shaders/MarkerFS.js",
  wgsl: "packages/engine/Source/Shaders/WebGPU/MarkerWGSL.wgsl",
  wgslModule: "packages/engine/Source/Shaders/WebGPU/MarkerWGSL.js",
  wasm: "packages/engine/Source/ThirdParty/Workers/marker_bg.wasm",
  widgetsCss: "packages/widgets/Source/widgets.css",
  testWorker: "Specs/TestWorkers/returnMarker.js",
};

const OUT_DEFAULT = "Build/CesiumUnminified";
const OUT_RELEASE = "Build/Cesium";

const engineMarker = (tag) =>
  `export default function Marker() {\n  return "ENGINE-${tag}";\n}\n`;
const glslMarker = (tag) =>
  `float glslMarker${tag}() {\n  return 0.0;\n}\nvoid main() {}\n`;
const wgslMarker = (tag) =>
  `// a WGSL comment\nfn wgslMarker${tag}() -> f32 {\n  return 0.0;\n}\n`;

// A repository with one of everything a lane serves: an engine module, a GLSL
// and a WGSL shader, a worker, a third-party worker beside a `.wasm`, an
// asset, the widgets CSS, a spec per workspace (each also importing a shader
// module), the Specs entry points and one test worker.
const FILES = {
  "package.json":
    '{"name":"freshness-sandbox","private":true,"type":"module"}\n',
  "node_modules/.package-lock.json": '{"lockfileVersion":3,"packages":{}}\n',
  "Source/copyrightHeader.js": "/** sandbox ${version} */\n",
  "packages/engine/package.json": `${JSON.stringify({
    name: "@cesium/engine",
    version: "0.0.0",
    type: "module",
    main: "index.js",
    exports: { ".": "./index.js", "./index-wgsl.js": "./index-wgsl.js" },
  })}\n`,
  [MARK.engine]: engineMarker("T0"),
  [MARK.glsl]: glslMarker("G0"),
  [MARK.wgsl]: wgslMarker("W0"),
  "packages/engine/Source/Shaders/Builtin/Functions/sandboxIdentity.glsl":
    "float czm_sandboxIdentity(float x) {\n  return x;\n}\n",
  "packages/engine/Source/Workers/createTaskProcessorWorker.js":
    "export default function createTaskProcessorWorker(f) {\n  return f;\n}\n",
  "packages/engine/Source/Workers/markerWorker.js":
    'import Marker from "../Core/Marker.js";\nexport default Marker;\n',
  "packages/engine/Source/ThirdParty/google-earth-dbroot-parser.js":
    "export default {};\n",
  "packages/engine/Source/ThirdParty/Workers/marker_glue.js":
    'export default "glue";\n',
  "packages/engine/Source/Assets/marker.json": '{"asset":"A0"}\n',
  "packages/engine/Source/Widget/CesiumWidget.css":
    ".cesium-widget {\n  color: red;\n}\n",
  "packages/widgets/package.json": `${JSON.stringify({
    name: "@cesium/widgets",
    version: "0.0.0",
    type: "module",
    main: "index.js",
  })}\n`,
  "packages/widgets/Source/Viewer/Viewer.js":
    'export default function Viewer() {\n  return "WIDGETS-V0";\n}\n',
  [MARK.widgetsCss]:
    '@import url("../../engine/Source/Widget/CesiumWidget.css");\n',
  "packages/widgets/Source/lighter.css":
    '@import url("../../engine/Source/Widget/CesiumWidget.css");\n',
  "packages/engine/Specs/Core/MarkerSpec.js":
    'import { Marker } from "../../index.js";\nimport MarkerFS from "../../Source/Shaders/MarkerFS.js";\nglobalThis.markerSpec = [Marker, MarkerFS];\n',
  "packages/widgets/Specs/Viewer/ViewerSpec.js":
    'import { Viewer } from "../../index.js";\nimport { _shadersMarkerFS, _shadersMarkerWGSL } from "@cesium/engine";\nglobalThis.viewerSpec = [Viewer, _shadersMarkerFS, _shadersMarkerWGSL];\n',
  "Specs/spec-main.js": 'globalThis.specMain = "spec-main";\n',
  "Specs/karma-main.js": 'globalThis.karmaMain = "karma-main";\n',
  "Specs/createScene.js": "export default function createScene() {}\n",
  [MARK.testWorker]:
    'import { Marker } from "@cesium/engine";\nexport default Marker;\n',
};

/** The flavours the lanes serve. */
const DEVELOPMENT = { variant: "dual", minify: false, removePragmas: false };
const RELEASE = { variant: "dual", minify: true, removePragmas: true };

// The steps `npm run build-release` (buildRelease) runs, with its options.
const BUILD_RELEASE = [
  ["buildEngine", {}],
  ["buildWidgets", {}],
  [
    "buildCesium",
    {
      minify: false,
      removePragmas: false,
      node: true,
      sourcemap: false,
      variant: "dual",
    },
  ],
  [
    "buildCesium",
    {
      minify: true,
      removePragmas: true,
      node: true,
      sourcemap: false,
      variant: "dual",
    },
  ],
];

// Runs build steps in a child whose working directory is the sandbox. A step
// is [exportName, ...args] of scripts/build.js, or one of:
// - ["planFull", argv]: the full build `gulp test` runs for those arguments;
// - ["watchStart", options]: starts the watch `gulp buildWatch` keeps alive
//   (startCesiumWatchBuild), which lives until the last step has run;
// - ["watch", rebuildName]: runs one of that watch's rebuilds, as a change
//   to a watched file does, and prints "FRESHNESS-WATCH rebuildName ok" or
//   "FRESHNESS-WATCH rebuildName threw <message>": a rebuild that throws does
//   not end the child;
// - ["handlers"]: prints the names of the rebuilds the watch returns, as
//   "FRESHNESS-HANDLERS [json]";
// - ["watchTogether", [rebuildName, ...]]: starts those rebuilds in the same
//   tick and awaits them together; prints "FRESHNESS-TOGETHER [outcomes]";
// - ["watchOverlap", first, second, records, directory, flavour]: starts one
//   rebuild; once it has removed the records and still runs, a stamping build
//   writes them again (the stamping build vouches for `directory`, of that
//   `flavour`) and then the second rebuild starts; both are awaited together.
//   Prints "FRESHNESS-OVERLAP {removed, inFlight, placed, outcomes}";
// - ["records", tag, [path, ...]]: prints which of those record files exist,
//   as "FRESHNESS-RECORDS tag [json]";
// - ["contains", path, text]: prints "FRESHNESS-CONTAINS path true|false", or
//   "missing" for a file that is not there;
// - ["write", path, contents]: edits a file between two steps;
// - ["mkdir", path]: makes a directory (where a record's file was) between two steps;
// - ["settle", milliseconds]: waits, so that work a rewrite left running in
//   the background has time to write;
// - ["remove", path]: deletes a file between two steps;
// - ["lane", laneKey]: prints the lane's decision as "FRESHNESS-LANE key decision".
const DRIVER = `
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const build = await import(process.env.FRESHNESS_BUILD_MODULE);
const { planSpecTestLane } = await import(process.env.FRESHNESS_PLAN_MODULE);
const { checkSpecLaneFreshness, outputRecord, runStampedBuild, specRecord, testWorkersRecord } =
  await import(process.env.FRESHNESS_MODULE);
let watch = null;
const settle = (promise) => promise.then(() => "ok", () => "threw");
// A build that stamps while the watch runs and writes only its records.
const stampRecords = (directory, flavour) =>
  runStampedBuild(
    [outputRecord(directory, flavour), specRecord("combined"), testWorkersRecord()],
    async () => {},
  );
for (const [name, ...args] of JSON.parse(process.env.FRESHNESS_STEPS)) {
  if (name === "watchStart") {
    watch = await build.startCesiumWatchBuild(args[0]);
    continue;
  }
  if (name === "watch") {
    if (typeof watch[args[0]] !== "function") {
      throw new Error("the watch has no rebuild " + args[0]);
    }
    try {
      await watch[args[0]]();
      console.log("FRESHNESS-WATCH " + args[0] + " ok");
    } catch (error) {
      const message = String(error && error.message)
        .split("\\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" | ");
      console.log(
        "FRESHNESS-WATCH " + args[0] + " threw " + message.slice(0, 400),
      );
    }
    continue;
  }
  if (name === "handlers") {
    console.log(
      "FRESHNESS-HANDLERS " +
        JSON.stringify(Object.keys(watch).filter((key) => key !== "dispose")),
    );
    continue;
  }
  if (name === "watchTogether") {
    const outcomes = await Promise.all(args[0].map((rebuild) => settle(watch[rebuild]())));
    console.log("FRESHNESS-TOGETHER " + JSON.stringify(outcomes));
    continue;
  }
  if (name === "watchOverlap") {
    // The first rewrite runs; once it has removed the records and is still
    // running, a build stamps them again, and then the second rewrite starts.
    const [first, second, records, directory, flavour] = args;
    let firstDone = false;
    const firstOutcome = settle(watch[first]()).then((outcome) => {
      firstDone = true;
      return outcome;
    });
    const deadline = Date.now() + 30000;
    while (records.some((file) => existsSync(file)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const removed = !records.some((file) => existsSync(file));
    const inFlight = !firstDone;
    await stampRecords(directory, flavour);
    const placed = records.every((file) => existsSync(file));
    const outcomes = await Promise.all([firstOutcome, settle(watch[second]())]);
    console.log(
      "FRESHNESS-OVERLAP " +
        JSON.stringify({ removed, inFlight, placed, outcomes }),
    );
    continue;
  }
  if (name === "records") {
    console.log(
      "FRESHNESS-RECORDS " + args[0] + " " +
        JSON.stringify(args[1].filter((file) => existsSync(file))),
    );
    continue;
  }
  if (name === "contains") {
    console.log(
      "FRESHNESS-CONTAINS " + args[0] + " " +
        (existsSync(args[0]) ? readFileSync(args[0], "utf8").includes(args[1]) : "missing"),
    );
    continue;
  }
  if (name === "write") {
    mkdirSync(dirname(args[0]), { recursive: true });
    writeFileSync(args[0], args[1]);
    continue;
  }
  if (name === "mkdir") {
    mkdirSync(args[0], { recursive: true });
    continue;
  }
  if (name === "settle") {
    await new Promise((resolve) => setTimeout(resolve, args[0]));
    continue;
  }
  if (name === "remove") {
    rmSync(args[0], { force: true });
    continue;
  }
  if (name === "lane") {
    const check = await checkSpecLaneFreshness(args[0]);
    console.log("FRESHNESS-LANE " + args[0] + " " + check.decision);
    continue;
  }
  const result =
    name === "planFull"
      ? await planSpecTestLane(args[0], build).full()
      : await build[name](...args);
  for (const value of Object.values(result ?? {})) {
    if (value && typeof value.dispose === "function") {
      await value.dispose();
    }
  }
}
if (watch) {
  await watch.dispose();
}
console.log("FRESHNESS-STEPS-DONE");
process.exit(0);
`;

/**
 * @param {string} root
 * @param {Array<[string, ...unknown[]]>} steps
 * @param {{expectFailure?: boolean, timeout?: number}} [options]
 */
function runSteps(root, steps, options = {}) {
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", DRIVER],
    {
      cwd: root,
      encoding: "utf8",
      timeout: options.timeout ?? 180000,
      env: {
        ...process.env,
        FRESHNESS_BUILD_MODULE: BUILD_MODULE,
        FRESHNESS_PLAN_MODULE: PLAN_MODULE,
        FRESHNESS_MODULE: FRESHNESS_MODULE,
        FRESHNESS_STEPS: JSON.stringify(steps),
      },
    },
  );
  const done =
    child.status === 0 && child.stdout.includes("FRESHNESS-STEPS-DONE");
  if (options.expectFailure) {
    assert.ok(
      !done,
      `the steps were expected to fail: ${JSON.stringify(steps)}`,
    );
    return child;
  }
  assert.ok(
    done,
    `steps ${JSON.stringify(steps)} exited ${child.status} ${child.signal ?? ""}\n${child.stderr.slice(-3000)}`,
  );
  return child;
}

function writeAt(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

const read = (root, relative) =>
  fs.readFileSync(path.join(root, relative), "utf8");
const readBytes = (root, relative) =>
  fs.readFileSync(path.join(root, relative));

/** The junctions a sandbox holds, removed before the sandbox is deleted. */
const JUNCTIONS = [
  "node_modules/@cesium/engine",
  "node_modules/@cesium/widgets",
  "Source/Widgets",
];

/**
 * Runs `body(root)` in a fresh sandbox repository.
 *
 * @param {(root: string) => Promise<void>} body
 * @param {{aliasSourceWidgets?: boolean}} [options] `aliasSourceWidgets`
 *   makes the root `Source/Widgets`, where `buildCesium` copies and then
 *   rewrites the widgets CSS, a junction to `packages/widgets/Source`: the
 *   build then edits a hashed source after it has bundled it.
 */
async function withBuildSandbox(body, options = {}) {
  const root = mkLaneTmp("freshness-builds-");
  try {
    for (const [relative, contents] of Object.entries(FILES)) {
      writeAt(root, relative, contents);
    }
    writeAt(root, MARK.wasm, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    fs.mkdirSync(path.join(root, "node_modules/@cesium"), { recursive: true });
    fs.symlinkSync(
      path.join(root, "packages/engine"),
      path.join(root, "node_modules/@cesium/engine"),
      "junction",
    );
    fs.symlinkSync(
      path.join(root, "packages/widgets"),
      path.join(root, "node_modules/@cesium/widgets"),
      "junction",
    );
    if (options.aliasSourceWidgets) {
      fs.symlinkSync(
        path.join(root, "packages/widgets/Source"),
        path.join(root, "Source/Widgets"),
        "junction",
      );
    }
    writeBarrelStubs(root);
    await body(root);
  } finally {
    for (const link of JUNCTIONS) {
      try {
        fs.rmdirSync(path.join(root, link));
      } catch {
        // not created
      }
    }
    removeLaneTmp(root);
  }
}

// The engine barrel generator re-exports some TypeScript modules by name. A
// stub that exports exactly those names stands in for each of them, so the
// real createIndexJs / createCesiumJs output resolves in the sandbox.
function writeBarrelStubs(root) {
  runSteps(root, [["createIndexJs", "engine"]]);
  const barrels = ["packages/engine/index.js", "packages/engine/index-wgsl.js"]
    .map((file) => read(root, file))
    .join("\n");
  const pattern =
    /export\s*\{([^}]*)\}\s*from\s*["'](\.\/Source\/[^"']+)\.js["']/g;
  /** @type {Map<string, Set<string>>} */
  const wanted = new Map();
  for (const match of barrels.matchAll(pattern)) {
    const modulePath = match[2];
    if (fs.existsSync(path.join(root, "packages/engine", `${modulePath}.js`))) {
      continue;
    }
    const names = wanted.get(modulePath) ?? new Set();
    for (const item of match[1].split(",")) {
      if (item.trim()) {
        names.add(item.trim());
      }
    }
    wanted.set(modulePath, names);
  }
  for (const [modulePath, names] of wanted) {
    const lines = new Set(
      [...names].map((item) =>
        item.startsWith("default as ")
          ? "export default class {}"
          : `export const ${item} = {};`,
      ),
    );
    writeAt(
      root,
      path.join("packages/engine", `${modulePath}.ts`),
      `${[...lines].join("\n")}\n`,
    );
  }
}

const lane = (root, key) => checkSpecLaneFreshness(key, { cwd: root });

async function recordCheck(root, descriptor) {
  const snapshot = await takeSourceSnapshot({
    cwd: root,
    groups: descriptor.groups,
  });
  return checkRecord(descriptor, snapshot, { cwd: root });
}

describe("builds", { concurrency: 3 }, () => {
  test("builds: a default-lane build never vouches for the release lane's Build/Cesium, and a Build/Cesium of another flavour is refused", () =>
    withBuildSandbox(async (root) => {
      runSteps(root, BUILD_RELEASE);
      assert.equal((await lane(root, "combined")).decision, "none");
      assert.equal((await lane(root, "release")).decision, "none");
      const releaseRecord = readBytes(
        root,
        path.relative(
          root,
          recordPath(outputRecord(OUT_RELEASE), { cwd: root }),
        ),
      );

      // An engine edit, then the full build `gulp test` runs for the default
      // lane: it rewrites Build/CesiumUnminified, never Build/Cesium.
      writeAt(root, MARK.engine, engineMarker("T1"));
      runSteps(root, [["planFull", {}]]);

      assert.deepEqual(
        readBytes(
          root,
          path.relative(
            root,
            recordPath(outputRecord(OUT_RELEASE), { cwd: root }),
          ),
        ),
        releaseRecord,
        "the default-lane build left Build/Cesium's record byte-unchanged",
      );
      assert.equal((await lane(root, "combined")).decision, "none");
      assert.ok(read(root, `${OUT_DEFAULT}/Cesium.js`).includes("ENGINE-T1"));
      assert.ok(read(root, `${OUT_RELEASE}/Cesium.js`).includes("ENGINE-T0"));
      const release = await lane(root, "release");
      assert.equal(release.decision, "refuse");
      assert.equal(release.output.comparison.reason, "source-drift");
      assert.deepEqual(release.output.comparison.changedSources, [MARK.engine]);
      assert.ok(
        release.report.includes("npm run build-release"),
        release.report,
      );

      // `gulp build --minify` writes a current Build/Cesium that keeps the
      // debug pragmas: the release lane serves the pragma-stripped flavour.
      runSteps(root, [
        ["buildCesium", { iife: true, minify: true, removePragmas: false }],
      ]);
      const minified = await lane(root, "release");
      assert.equal(minified.decision, "refuse");
      assert.equal(minified.output.comparison.reason, "flavour-mismatch");
      assert.deepEqual(minified.output.comparison.expectedFlavour, RELEASE);
      assert.ok(
        minified.report.includes("removePragmas=false") &&
          minified.report.includes("removePragmas=true"),
        minified.report,
      );
      assert.equal((await lane(root, "combined")).decision, "none");
    }));

  test("builds: a widgets-only build never vouches for the engine workers the widgets lane serves", () =>
    withBuildSandbox(async (root) => {
      runSteps(root, [["planFull", { workspace: "@cesium/widgets" }]]);
      assert.equal((await lane(root, "widgets")).decision, "none");
      const workersRecord = readBytes(
        root,
        path.relative(root, recordPath(engineWorkersRecord(), { cwd: root })),
      );

      // `npm run build --workspace @cesium/widgets` runs buildWidgets alone.
      writeAt(root, MARK.engine, engineMarker("T1"));
      runSteps(root, [["buildWidgets", {}]]);

      const widgets = await lane(root, "widgets");
      assert.equal(widgets.spec.fresh, true, "buildWidgets stamped its bundle");
      assert.notEqual(widgets.decision, "none");
      assert.equal(widgets.decision, "full");
      const workers = widgets.records.find(
        (check) => check.descriptor.kind === "engine-workers",
      );
      assert.deepEqual(workers.comparison.changedSources, [MARK.engine]);
      assert.deepEqual(
        readBytes(
          root,
          path.relative(root, recordPath(engineWorkersRecord(), { cwd: root })),
        ),
        workersRecord,
      );
      assert.ok(
        read(root, "packages/engine/Build/Workers/markerWorker.js").includes(
          "ENGINE-T0",
        ),
        "the served engine workers are still the old ones",
      );

      // The lane's own full build refreshes them.
      runSteps(root, [["planFull", { workspace: "widgets" }]]);
      assert.equal((await lane(root, "widgets")).decision, "none");
      assert.ok(
        read(root, "packages/engine/Build/Workers/markerWorker.js").includes(
          "ENGINE-T1",
        ),
      );
    }));

  test("builds: a shader edited after an earlier step generated its module is bundled by every build whose record hashes it", () =>
    withBuildSandbox(async (root) => {
      runSteps(root, [["buildEngine", {}]]);
      assert.ok(read(root, MARK.glslModule).includes("glslMarkerG0"));

      // Both shaders are edited after the previous step generated their
      // modules, and the modules are given a later mtime, so a generator that
      // trusted mtimes would keep them.
      const editShaders = (tag) => {
        writeAt(root, MARK.glsl, glslMarker(`G${tag}`));
        writeAt(root, MARK.wgsl, wgslMarker(`W${tag}`));
        const later = new Date(Date.now() + 3600 * 1000);
        for (const module of [MARK.glslModule, MARK.wgslModule]) {
          fs.utimesSync(path.join(root, module), later, later);
        }
      };

      editShaders("1");
      runSteps(root, [["buildWidgets", {}]]);
      const widgetsCheck = await recordCheck(root, specRecord("widgets"));
      assert.equal(widgetsCheck.comparison.fresh, true);
      const widgetsBundle = read(
        root,
        "packages/widgets/Build/Specs/SpecList.js",
      );
      assert.ok(widgetsBundle.includes("glslMarkerG1"), "widgets bundle GLSL");
      assert.ok(widgetsBundle.includes("wgslMarkerW1"), "widgets bundle WGSL");
      assert.ok(!widgetsBundle.includes("glslMarkerG0"));

      // Again, after buildWidgets generated them: buildCesium must bundle the
      // edit its records hash.
      editShaders("2");
      runSteps(root, [["buildCesium", { iife: true, clean: false }]]);
      const outputCheck = await recordCheck(
        root,
        outputRecord(OUT_DEFAULT, DEVELOPMENT),
      );
      assert.equal(outputCheck.comparison.fresh, true);
      const cesium = read(root, `${OUT_DEFAULT}/Cesium.js`);
      assert.ok(cesium.includes("glslMarkerG2"), "Cesium.js GLSL");
      assert.ok(cesium.includes("wgslMarkerW2"), "Cesium.js WGSL");
      assert.ok(
        !cesium.includes("glslMarkerG1") && !cesium.includes("wgslMarkerW1"),
      );
      const combinedCheck = await recordCheck(root, specRecord("combined"));
      assert.equal(combinedCheck.comparison.fresh, true);
      const combinedBundle = read(root, "Build/Specs/SpecList.js");
      assert.ok(
        combinedBundle.includes("glslMarkerG2"),
        "combined bundle GLSL",
      );
    }));

  test("builds: a .wasm-only change stales the lane until a build serves it; a failed, interrupted or watch build leaves no record", () =>
    withBuildSandbox(async (root) => {
      runSteps(root, [["planFull", {}]]);
      assert.equal((await lane(root, "combined")).decision, "none");

      // A rebuilt kernel: only the tracked binary changes.
      const kernel = Buffer.from([0, 97, 115, 109, 1, 0, 0, 1]);
      writeAt(root, MARK.wasm, kernel);
      const wasmOnly = await lane(root, "combined");
      assert.equal(wasmOnly.decision, "full");
      assert.deepEqual(wasmOnly.output.comparison.changedSources, [MARK.wasm]);
      runSteps(root, [["planFull", {}]]);
      assert.equal((await lane(root, "combined")).decision, "none");
      assert.deepEqual(
        readBytes(root, `${OUT_DEFAULT}/ThirdParty/Workers/marker_bg.wasm`),
        kernel,
      );

      // A build that writes Cesium.js and then fails in the test-worker step
      // (the same as one interrupted there) leaves no record behind.
      writeAt(root, MARK.engine, engineMarker("T2"));
      writeAt(root, "Specs/TestWorkers/broken.js", "export default {;\n");
      runSteps(root, [["planFull", {}]], { expectFailure: true });
      assert.ok(read(root, `${OUT_DEFAULT}/Cesium.js`).includes("ENGINE-T2"));
      for (const descriptor of [
        outputRecord(OUT_DEFAULT, DEVELOPMENT),
        specRecord("combined"),
        testWorkersRecord(),
      ]) {
        assert.ok(
          !fs.existsSync(recordPath(descriptor, { cwd: root })),
          descriptor.label,
        );
      }
      // Back on the sources the old records hashed, the lane is still stale:
      // the served Cesium.js holds the failed build's code.
      writeAt(root, MARK.engine, engineMarker("T0"));
      fs.rmSync(path.join(root, "Specs/TestWorkers/broken.js"));
      const afterFailure = await lane(root, "combined");
      assert.notEqual(afterFailure.decision, "none");
      assert.equal(afterFailure.output.comparison.reason, "manifest-missing");

      // A watch build rewrites its output and the combined spec bundle later
      // without stamping, so it removes their records when it starts.
      runSteps(root, [["planFull", {}]]);
      assert.equal((await lane(root, "combined")).decision, "none");
      runSteps(root, [["buildCesium", { incremental: true }]]);
      const watched = await lane(root, "combined");
      assert.notEqual(watched.decision, "none");
      assert.equal(watched.spec.comparison.reason, "manifest-missing");
      assert.equal(watched.output.comparison.reason, "manifest-missing");
    }));

  // The watch's five rewrites, two rows each: one whose body succeeds and one
  // whose body fails. Each row is the edit that fires the handler, the outcome
  // the handler must have, and what undoes the edit. After any rewrite, whether
  // its body succeeded or failed, none of the three records the watch's
  // directories carry is left, and the watch wrote none: a succeeding row
  // pins that the rewrite stamps nothing, a failing row pins that the records
  // are removed before the body runs (removed after it, a body that throws
  // would leave them). A succeeding row also asserts what the rewrite wrote:
  // each `served` file holds the `served.text` of the edit.
  //
  // The three handlers that rebuild the IIFE need `Build/InlineWorkers.js`,
  // the file the IIFE bundle injects. The full build the plan runs while the
  // watch is alive deletes it, so the watch's IIFE rebuild then fails on its
  // missing import. That deletion is main's behaviour (`bundleCesiumJs`
  // removes the file after a full IIFE build); this change does not repair
  // it. A failing row of these handlers removes the file
  // (`inject: "absent"`), so it fails whatever the full build does with it.
  // A succeeding row writes it (`inject: "present"`): that row stands in for
  // the watch as it behaves once the full build no longer deletes the file
  // under a live watch, which is the one case in which these handlers
  // succeed.
  const WATCHED_SPEC = "packages/engine/Specs/Core/MarkerSpec.js";
  const ADDED_SPEC = "packages/engine/Specs/Core/AddedSpec.js";
  const INJECT_FILE = "Build/InlineWorkers.js";
  const INJECT_CONTENTS = 'globalThis.CESIUM_WORKERS = "";\n';
  const NOT_PARSEABLE = "export default {;\n";
  // Why a failing row's body fails: the IIFE rebuild cannot resolve its inject
  // file, or esbuild cannot parse the spec.
  const INJECT_MISSING = /Could not resolve "Build\/InlineWorkers\.js"/;
  const NOT_PARSED = /Expected identifier/;
  const ENGINE_OUTPUTS = [
    `${OUT_DEFAULT}/index.js`,
    `${OUT_DEFAULT}/Cesium.js`,
  ];
  // `rebuildSources` also rebuilds the workers of the output directory: the
  // worker that imports the edited module holds the edit too.
  const SOURCES_OUTPUTS = [
    ...ENGINE_OUTPUTS,
    `${OUT_DEFAULT}/Workers/markerWorker.js`,
  ];
  const SPEC_OUTPUT = ["Build/Specs/SpecList.js"];
  const WATCH_REWRITES = [
    {
      handler: "rebuildGlsl",
      body: "succeeds",
      change: "a GLSL shader is edited",
      inject: "present",
      file: MARK.glsl,
      edited: glslMarker("G1"),
      original: FILES[MARK.glsl],
      served: {
        text: "glslMarkerG1",
        before: "glslMarkerG0",
        files: ENGINE_OUTPUTS,
      },
    },
    {
      handler: "rebuildGlsl",
      body: "fails",
      change: "a GLSL shader is edited and the IIFE's inject file is missing",
      inject: "absent",
      file: MARK.glsl,
      edited: glslMarker("G1"),
      original: FILES[MARK.glsl],
      reason: INJECT_MISSING,
    },
    {
      handler: "rebuildWgsl",
      body: "succeeds",
      change: "a WGSL shader is edited",
      inject: "present",
      file: MARK.wgsl,
      edited: wgslMarker("W1"),
      original: FILES[MARK.wgsl],
      served: {
        text: "wgslMarkerW1",
        before: "wgslMarkerW0",
        files: ENGINE_OUTPUTS,
      },
    },
    {
      handler: "rebuildWgsl",
      body: "fails",
      change: "a WGSL shader is edited and the IIFE's inject file is missing",
      inject: "absent",
      file: MARK.wgsl,
      edited: wgslMarker("W1"),
      original: FILES[MARK.wgsl],
      reason: INJECT_MISSING,
    },
    {
      handler: "rebuildSources",
      body: "succeeds",
      change: "an engine source is edited",
      inject: "present",
      file: MARK.engine,
      edited: engineMarker("T1"),
      original: FILES[MARK.engine],
      served: {
        text: "ENGINE-T1",
        before: "ENGINE-T0",
        files: SOURCES_OUTPUTS,
      },
    },
    {
      handler: "rebuildSources",
      body: "fails",
      change:
        "an engine source is edited and the IIFE's inject file is missing",
      inject: "absent",
      file: MARK.engine,
      edited: engineMarker("T1"),
      original: FILES[MARK.engine],
      reason: INJECT_MISSING,
    },
    {
      handler: "rebuildSpecList",
      body: "succeeds",
      change: "a spec file is added",
      file: ADDED_SPEC,
      edited: 'globalThis.watchEdit = "SPEC-ADDED";\n',
      original: null,
      served: {
        text: "SPEC-ADDED",
        before: "markerSpec",
        files: SPEC_OUTPUT,
      },
    },
    {
      handler: "rebuildSpecList",
      body: "fails",
      change: "a spec file that does not parse is added",
      file: ADDED_SPEC,
      edited: NOT_PARSEABLE,
      original: null,
      reason: NOT_PARSED,
    },
    {
      handler: "rebuildSpecs",
      body: "succeeds",
      change: "a spec is edited",
      file: WATCHED_SPEC,
      edited: `${FILES[WATCHED_SPEC]}globalThis.watchEdit = "SPEC-W1";\n`,
      original: FILES[WATCHED_SPEC],
      served: {
        text: "SPEC-W1",
        before: "markerSpec",
        files: SPEC_OUTPUT,
      },
    },
    {
      handler: "rebuildSpecs",
      body: "fails",
      change: "a spec is edited so that it does not parse",
      file: WATCHED_SPEC,
      edited: NOT_PARSEABLE,
      original: FILES[WATCHED_SPEC],
      reason: NOT_PARSED,
    },
  ];

  for (const row of WATCH_REWRITES) {
    test(`builds: a watch's ${row.handler}, whose body ${row.body}, when ${row.change}, removes the records of what it rewrites before it writes, so a build that stamped while the watch ran never vouches for the watch's bytes`, (t) =>
      withBuildSandbox(async (root) => {
        const child = runSteps(root, [
          // `npm run build-watch`, left running.
          ["watchStart", {}],
          // `npm test` while the watch runs: the plan's full build stamps.
          ["planFull", {}],
          ["lane", "combined"],
          // The IIFE's inject file, present or missing, for the handlers that
          // rebuild the IIFE.
          ...(row.inject === "present"
            ? [["write", INJECT_FILE, INJECT_CONTENTS]]
            : []),
          ...(row.inject === "absent" ? [["remove", INJECT_FILE]] : []),
          // The edit, and the watch's rewrite for it.
          ["write", row.file, row.edited],
          ["watch", row.handler],
          // The edit is undone (a stash), with the watch's output still served.
          row.original === null
            ? ["remove", row.file]
            : ["write", row.file, row.original],
        ]);
        assert.ok(
          child.stdout.includes("FRESHNESS-LANE combined none"),
          `the full build stamped the lane while the watch ran\n${child.stdout.slice(-2000)}`,
        );
        const outcome = new RegExp(
          `FRESHNESS-WATCH ${row.handler} (ok|threw)(.*)`,
        ).exec(child.stdout);
        assert.ok(
          outcome,
          `the child ran ${row.handler}\n${child.stdout.slice(-2000)}`,
        );
        t.diagnostic(
          `${row.handler}: ${outcome[1]}${outcome[1] === "threw" ? `:${outcome[2]}` : ""}`,
        );
        assert.equal(
          outcome[1],
          row.body === "succeeds" ? "ok" : "threw",
          `${row.handler}: its body ${row.body}, and the child reported ${outcome[1]}${outcome[2]}`,
        );
        if (row.reason) {
          assert.match(
            outcome[2],
            row.reason,
            `${row.handler} failed, but not for the reason the row names`,
          );
        }
        if (row.served) {
          for (const file of row.served.files) {
            assert.ok(
              read(root, file).includes(row.served.text),
              `${row.handler} wrote ${row.served.text} into ${file}`,
            );
          }
        }
        if (row.original === null) {
          assert.ok(!fs.existsSync(path.join(root, row.file)));
        } else {
          assert.equal(read(root, row.file), row.original);
        }

        for (const descriptor of [
          outputRecord(OUT_DEFAULT, DEVELOPMENT),
          specRecord("combined"),
          testWorkersRecord(),
        ]) {
          assert.ok(
            !fs.existsSync(recordPath(descriptor, { cwd: root })),
            `${descriptor.label} was removed before ${row.handler}'s rewrite`,
          );
        }
        const combined = await lane(root, "combined");
        assert.notEqual(combined.decision, "none", combined.report);
        assert.equal(combined.spec.comparison.reason, "manifest-missing");
        assert.equal(combined.output.comparison.reason, "manifest-missing");
      }));
  }

  // The rows above run each handler once. The handlers' names are read from
  // the object the watch returns, so a handler added to the watch without a
  // row, and without a call in the sequence below, turns the spec red.
  const ROW_HANDLERS = [
    ...new Set(WATCH_REWRITES.map((row) => row.handler)),
  ].sort();

  /** The records the watch's rewrites cover, by absolute path. */
  const watchRecordPaths = (
    root,
    directory = OUT_DEFAULT,
    flavour = DEVELOPMENT,
  ) =>
    [
      outputRecord(directory, flavour),
      specRecord("combined"),
      testWorkersRecord(),
    ].map((descriptor) => recordPath(descriptor, { cwd: root }));

  /**
   * Reads the child's report in order: `take(kind, what)` returns the text of
   * the next report line, which must be of that kind.
   */
  function reportReader(child) {
    const lines = [...child.stdout.matchAll(/^FRESHNESS-([A-Z]+) (.*)$/gm)].map(
      (match) => ({ kind: match[1], text: match[2] }),
    );
    return (kind, what) => {
      const line = lines.shift();
      assert.ok(
        line && line.kind === kind,
        `${what}: expected a ${kind} report, got ${JSON.stringify(line)}\n${child.stdout.slice(-3000)}`,
      );
      return line.text;
    };
  }

  test("builds: the handlers the watch returns are exactly the ones the rows cover", () =>
    withBuildSandbox(async (root) => {
      const child = runSteps(root, [["watchStart", {}], ["handlers"]]);
      const take = reportReader(child);
      assert.deepEqual(
        JSON.parse(take("HANDLERS", "handlers")).sort(),
        ROW_HANDLERS,
        "the watch returns a handler no row covers, or a row covers a handler the watch does not return",
      );
    }));

  // One watch, alive for the whole sequence, with a build that stamps right
  // before EVERY rewrite (the plan's full build, as `npm test` runs it beside a
  // watch). After every rewrite none of the three records is left and the
  // watch wrote none, so the lane that the stamping build vouched for reads
  // stale over the watch's bytes. Every handler is called at least twice, one
  // three times with a failing call between two succeeding ones; each handler
  // follows a different handler at least once; and the sequence ends with
  // two different handlers started together, two overlapping (one still
  // running when a build stamps the records again and the other starts), and
  // the same handler started twice that way.
  const IIFE_HANDLERS = new Set([
    "rebuildGlsl",
    "rebuildWgsl",
    "rebuildSources",
  ]);
  const EDITS = {
    rebuildGlsl: (n) => ({
      file: MARK.glsl,
      edited: glslMarker(`G${n}`),
      original: FILES[MARK.glsl],
      text: `glslMarkerG${n}`,
      files: ENGINE_OUTPUTS,
    }),
    rebuildWgsl: (n) => ({
      file: MARK.wgsl,
      edited: wgslMarker(`W${n}`),
      original: FILES[MARK.wgsl],
      text: `wgslMarkerW${n}`,
      files: ENGINE_OUTPUTS,
    }),
    rebuildSources: (n) => ({
      file: MARK.engine,
      edited: engineMarker(`T${n}`),
      original: FILES[MARK.engine],
      text: `ENGINE-T${n}`,
      files: SOURCES_OUTPUTS,
    }),
    rebuildSpecList: (n) => ({
      file: ADDED_SPEC,
      edited: `globalThis.watchEdit = "SPEC-ADDED${n}";\n`,
      original: null,
      text: `SPEC-ADDED${n}`,
      files: SPEC_OUTPUT,
    }),
    rebuildSpecs: (n) => ({
      file: WATCHED_SPEC,
      edited: `${FILES[WATCHED_SPEC]}globalThis.watchEdit = "SPEC-W${n}";\n`,
      original: FILES[WATCHED_SPEC],
      text: `SPEC-W${n}`,
      files: SPEC_OUTPUT,
    }),
  };
  const BROKEN_SPEC_EDIT = {
    file: WATCHED_SPEC,
    edited: NOT_PARSEABLE,
    original: FILES[WATCHED_SPEC],
  };
  const LONG_WATCH = [
    { calls: ["rebuildSpecs"] },
    { calls: ["rebuildSources"] },
    { calls: ["rebuildGlsl"] },
    { calls: ["rebuildSpecList"] },
    { calls: ["rebuildWgsl"] },
    { calls: ["rebuildSpecs"], fails: true },
    { calls: ["rebuildSources"] },
    { calls: ["rebuildSpecs"] },
    { calls: ["rebuildGlsl"] },
    { calls: ["rebuildWgsl"] },
    { calls: ["rebuildSpecList"] },
    { calls: ["rebuildGlsl", "rebuildSpecList"], how: "together" },
    { calls: ["rebuildSources", "rebuildSpecs"], how: "overlap" },
    { calls: ["rebuildSources", "rebuildSources"], how: "overlap" },
  ];

  test("builds: in one long watch, every rewrite of every handler, however many came before and whether or not one failed or another is running, removes the records a build stamped just before it", () =>
    withBuildSandbox(async (root) => {
      const paths = watchRecordPaths(root);
      const steps = [["watchStart", {}], ["handlers"]];
      /** @type {Array<(take: (kind: string, what: string) => string) => void>} */
      const checks = [
        (take) =>
          assert.deepEqual(
            JSON.parse(take("HANDLERS", "handlers")).sort(),
            [...new Set(LONG_WATCH.flatMap((entry) => entry.calls))].sort(),
            "the sequence calls every handler the watch returns, and only those",
          ),
      ];
      const add = (step, check) => {
        steps.push(step);
        if (check) {
          checks.push(check);
        }
      };
      const used = {};
      for (const [index, entry] of LONG_WATCH.entries()) {
        const number = index + 1;
        const label = `call ${number} (${entry.calls.join(" + ")}${entry.how ? `, ${entry.how}` : ""}${entry.fails ? ", failing" : ""})`;
        // One edit per file: the same handler called twice edits one file, and
        // the later call's text is what the file holds.
        const edits = entry.calls
          .map((handler) => {
            used[handler] = (used[handler] ?? 0) + 1;
            return entry.fails
              ? BROKEN_SPEC_EDIT
              : EDITS[handler](used[handler]);
          })
          .filter((edit, at, all) =>
            all.every((later, next) => next <= at || later.file !== edit.file),
          );

        // A build that stamps, as `npm test` runs beside the watch.
        add(["planFull", {}]);
        add(["lane", "combined"], (take) =>
          assert.equal(
            take("LANE", label),
            "combined none",
            `${label}: the stamping build vouched for the lane`,
          ),
        );
        if (entry.calls.some((handler) => IIFE_HANDLERS.has(handler))) {
          add(["write", INJECT_FILE, INJECT_CONTENTS]);
        }
        for (const edit of edits) {
          add(["write", edit.file, edit.edited]);
        }
        if (entry.how === "together") {
          add(["watchTogether", entry.calls], (take) =>
            assert.deepEqual(
              JSON.parse(take("TOGETHER", label)),
              ["ok", "ok"],
              `${label}: outcomes`,
            ),
          );
        } else if (entry.how === "overlap") {
          add(
            [
              "watchOverlap",
              entry.calls[0],
              entry.calls[1],
              paths,
              OUT_DEFAULT,
              DEVELOPMENT,
            ],
            (take) =>
              assert.deepEqual(
                JSON.parse(take("OVERLAP", label)),
                {
                  removed: true,
                  inFlight: true,
                  placed: true,
                  outcomes: ["ok", "ok"],
                },
                `${label}: the first rewrite removed the records and was still running when they were stamped again, and both succeeded`,
              ),
          );
        } else {
          add(["watch", entry.calls[0]], (take) => {
            const outcome = /^(\S+) (ok|threw)(.*)$/.exec(take("WATCH", label));
            assert.ok(outcome, label);
            assert.equal(outcome[1], entry.calls[0], label);
            assert.equal(
              outcome[2],
              entry.fails ? "threw" : "ok",
              `${label}: ${outcome[2]}${outcome[3]}`,
            );
            if (entry.fails) {
              assert.match(outcome[3], NOT_PARSED, `${label}: why it failed`);
            }
          });
        }
        // What the rewrites wrote.
        for (const edit of entry.fails ? [] : edits) {
          for (const file of edit.files) {
            add(["contains", file, edit.text], (take) =>
              assert.equal(
                take("CONTAINS", label),
                `${file} true`,
                `${label}: ${edit.text} is in ${file}`,
              ),
            );
          }
        }
        // None of the three records is left, and the watch wrote none.
        add(["records", `after call ${number}`, paths], (take) => {
          const text = take("RECORDS", label);
          assert.equal(
            text,
            `after call ${number} []`,
            `${label}: records left after the rewrite`,
          );
        });
        // The edits are undone, with the watch's output still served: the
        // sources are what the stamping build hashed.
        for (const edit of edits) {
          add(
            edit.original === null
              ? ["remove", edit.file]
              : ["write", edit.file, edit.original],
          );
        }
        add(["lane", "combined"], (take) => {
          const text = take("LANE", label);
          assert.ok(
            text.startsWith("combined ") && text !== "combined none",
            `${label}: the lane reads ${text} over the watch's bytes`,
          );
        });
      }

      const child = runSteps(root, steps, { timeout: 900000 });
      const take = reportReader(child);
      for (const check of checks) {
        check(take);
      }
      const combined = await lane(root, "combined");
      assert.notEqual(combined.decision, "none", combined.report);
      assert.equal(combined.spec.comparison.reason, "manifest-missing");
      assert.equal(combined.output.comparison.reason, "manifest-missing");
    }));

  // `gulp buildWatch --minify` writes Build/Cesium, which the release lane
  // serves: the watch's start and its rewrites remove that directory's
  // records, not the default directory's.
  test("builds: a watch started with minify removes the records of Build/Cesium when it starts and before each rewrite, so the release lane never reads a build the watch rewrote", () =>
    withBuildSandbox(async (root) => {
      const paths = watchRecordPaths(root, OUT_RELEASE, RELEASE);
      const child = runSteps(
        root,
        [
          // `npm run build-release` stamps Build/Cesium.
          ...BUILD_RELEASE,
          ["lane", "release"],
          ["records", "before the watch", paths],
          // `npm run build-watch -- --minify`.
          ["watchStart", { minify: true }],
          ["records", "after the watch started", paths],
          ["lane", "release"],
          // The release steps run again beside the watch, and stamp again.
          ...BUILD_RELEASE,
          ["lane", "release"],
          ["records", "before the rewrite", paths],
          ["write", INJECT_FILE, INJECT_CONTENTS],
          ["write", MARK.engine, engineMarker("T1")],
          ["watch", "rebuildSources"],
          ["contains", `${OUT_RELEASE}/index.js`, "ENGINE-T1"],
          ["contains", `${OUT_RELEASE}/Cesium.js`, "ENGINE-T1"],
          ["records", "after the rewrite", paths],
          ["write", MARK.engine, FILES[MARK.engine]],
          ["lane", "release"],
        ],
        { timeout: 900000 },
      );
      const take = reportReader(child);
      const records = (what) =>
        JSON.parse(/^[^[]*(\[.*\])$/.exec(take("RECORDS", what))[1]);
      assert.equal(take("LANE", "release"), "release none");
      assert.equal(
        records("before the watch").length,
        3,
        "the release steps stamped Build/Cesium, the spec bundle and the test workers",
      );
      assert.deepEqual(
        records("after the watch started"),
        [],
        "the watch's start left a record of Build/Cesium or of what it writes",
      );
      assert.notEqual(take("LANE", "release"), "release none");
      assert.equal(take("LANE", "release"), "release none");
      assert.equal(records("before the rewrite").length, 3);
      assert.equal(
        take("WATCH", "rebuildSources"),
        "rebuildSources ok",
        "the rewrite",
      );
      assert.equal(
        take("CONTAINS", "index.js"),
        `${OUT_RELEASE}/index.js true`,
      );
      assert.equal(
        take("CONTAINS", "Cesium.js"),
        `${OUT_RELEASE}/Cesium.js true`,
      );
      assert.deepEqual(
        records("after the rewrite"),
        [],
        "records of Build/Cesium (or of what the watch writes) left after the rewrite",
      );
      const afterwards = take("LANE", "release");
      assert.notEqual(afterwards, "release none");

      const release = await lane(root, "release");
      assert.notEqual(release.decision, "none", release.report);
      assert.equal(release.output.comparison.reason, "manifest-missing");
      assert.equal(release.spec.comparison.reason, "manifest-missing");
    }));

  // A record that cannot be removed stops the rewrite before its body writes.
  // The edit stays in place and the child waits after the rejection, so a body
  // that was started anyway (beside the removal, or after an error it
  // swallowed) has time to write the edit into the served files.
  for (const row of WATCH_REWRITES.filter(
    (entry) => entry.body === "succeeds",
  )) {
    test(`builds: a watch's ${row.handler}, when the output record cannot be removed, rejects before its body writes, and the served bytes keep what they held before the edit`, () =>
      withBuildSandbox(async (root) => {
        const [outputRecordFile] = watchRecordPaths(root);
        const child = runSteps(root, [
          ["watchStart", {}],
          ["planFull", {}],
          ["lane", "combined"],
          ...(row.inject === "present"
            ? [["write", INJECT_FILE, INJECT_CONTENTS]]
            : []),
          // A directory where the record's file was: it cannot be removed.
          ["remove", outputRecordFile],
          ["mkdir", outputRecordFile],
          ["write", row.file, row.edited],
          ["watch", row.handler],
          ["settle", 8000],
        ]);
        assert.ok(child.stdout.includes("FRESHNESS-LANE combined none"));
        const outcome = new RegExp(
          `FRESHNESS-WATCH ${row.handler} (ok|threw)(.*)`,
        ).exec(child.stdout);
        assert.ok(outcome, child.stdout.slice(-2000));
        assert.equal(
          outcome[1],
          "threw",
          `${row.handler} went on although a record could not be removed`,
        );
        assert.match(outcome[2], /EISDIR/, `${row.handler}: why it threw`);
        for (const file of row.served.files) {
          const served = read(root, file);
          assert.ok(
            !served.includes(row.served.text),
            `${row.handler} wrote ${row.served.text} into ${file}`,
          );
          assert.ok(
            served.includes(row.served.before),
            `${file} lost what it held before the edit (${row.served.before})`,
          );
        }
        assert.ok(fs.statSync(outputRecordFile).isDirectory());
      }));
  }

  test("builds: a source the build edits after it bundled it is never certified as built", () =>
    withBuildSandbox(
      async (root) => {
        // buildCesium bundles the widgets CSS, then copies it into
        // Source/Widgets and rewrites it there; through the junction that
        // rewrites packages/widgets/Source/widgets.css after the bundle read it.
        const before = read(root, MARK.widgetsCss);
        runSteps(root, [["planFull", {}]]);
        assert.notEqual(read(root, MARK.widgetsCss), before);
        assert.ok(
          read(root, `${OUT_DEFAULT}/Widgets/widgets.css`).includes(
            "cesium-widget",
          ),
        );

        const combined = await lane(root, "combined");
        assert.notEqual(combined.decision, "none");
        assert.ok(
          combined.output.comparison.changedSources.includes(MARK.widgetsCss),
          combined.report,
        );
      },
      { aliasSourceWidgets: true },
    ));

  // The other stamping sites of build.js. Each case stamps its lane with the
  // plan's full build, breaks one source the site reads so that the site's
  // REAL build fails after it wrote (the `witness` file, deleted beforehand,
  // is back afterwards), and then reads the lane. A site that wrote before it
  // removed its records, or took its snapshot, would leave the old records
  // beside the half-written directory.
  const BROKEN_SOURCE = "export default {;\n";
  const WRITE_SITES = [
    {
      site: "buildWidgets",
      fails: "on a spec that does not parse",
      plan: { workspace: "widgets" },
      lane: "widgets",
      step: ["buildWidgets", {}],
      records: [specRecord("widgets")],
      broken: "packages/widgets/Specs/Viewer/BrokenSpec.js",
      witness: "packages/widgets/Build/Unminified/index.js",
    },
    {
      site: "buildWorkspaceSpecBundle",
      fails: "on a spec that does not parse",
      plan: { workspace: "widgets" },
      lane: "widgets",
      step: ["buildWorkspaceSpecBundle", "widgets", {}],
      records: [specRecord("widgets")],
      broken: "packages/widgets/Specs/Viewer/BrokenSpec.js",
      witness: "packages/widgets/Specs/SpecList.js",
    },
    {
      site: "buildEngine",
      fails: "on a worker that does not parse",
      plan: { workspace: "engine" },
      lane: "engine",
      step: ["buildEngine", {}],
      records: [engineWorkersRecord(), specRecord("engine")],
      broken: "packages/engine/Source/Workers/brokenWorker.js",
      witness: "packages/engine/Build/Unminified/index.js",
    },
    // The workers bundler wipes the workers directory, record included, before
    // it writes: a failure in the index bundle, which runs first, leaves that
    // record to the helper alone.
    {
      site: "buildEngine",
      fails: "on a module that does not parse",
      plan: { workspace: "engine" },
      lane: "engine",
      step: ["buildEngine", {}],
      records: [engineWorkersRecord(), specRecord("engine")],
      broken: "packages/engine/Source/Core/Broken.js",
      witness: "packages/engine/index.js",
    },
    {
      site: "buildTestWorkers",
      fails: "on a test worker that does not parse",
      plan: { workspace: "engine" },
      lane: "engine",
      step: ["buildTestWorkers", {}],
      records: [testWorkersRecord()],
      broken: "Specs/TestWorkers/broken.js",
      witness: MARK.glslModule,
    },
    {
      site: "buildCombinedSpecBundle",
      fails: "on a spec that does not parse",
      plan: {},
      lane: "combined",
      step: ["buildCombinedSpecBundle", {}],
      records: [specRecord("combined")],
      broken: "packages/engine/Specs/Core/BrokenSpec.js",
      witness: "Specs/SpecList.js",
    },
  ];

  /** The check a lane's result holds for one record. */
  const checkFor = (result, descriptor) =>
    descriptor.kind === "spec-bundle"
      ? result.spec
      : result.records.find(
          (check) => check.descriptor.kind === descriptor.kind,
        );

  for (const site of WRITE_SITES) {
    test(`builds: ${site.site} ${site.fails}, after it wrote, leaves none of its records, so the lane never reads fresh over what it wrote`, () =>
      withBuildSandbox(async (root) => {
        runSteps(root, [["planFull", site.plan]]);
        assert.equal((await lane(root, site.lane)).decision, "none");
        for (const descriptor of site.records) {
          assert.ok(
            fs.existsSync(recordPath(descriptor, { cwd: root })),
            `${descriptor.label} is stamped before the failing build`,
          );
        }

        writeAt(root, site.broken, BROKEN_SOURCE);
        fs.rmSync(path.join(root, site.witness), { force: true });
        runSteps(root, [site.step], { expectFailure: true });
        assert.ok(
          fs.existsSync(path.join(root, site.witness)),
          `${site.site} wrote ${site.witness} before it failed`,
        );
        for (const descriptor of site.records) {
          assert.ok(
            !fs.existsSync(recordPath(descriptor, { cwd: root })),
            `${descriptor.label} was removed before ${site.site} wrote`,
          );
        }

        // Back on the sources the old records hashed, the lane still reads
        // stale: the directory holds what the failed build wrote.
        fs.rmSync(path.join(root, site.broken));
        const afterFailure = await lane(root, site.lane);
        assert.notEqual(afterFailure.decision, "none", afterFailure.report);
        for (const descriptor of site.records) {
          assert.equal(
            checkFor(afterFailure, descriptor).comparison.reason,
            "manifest-missing",
            descriptor.label,
          );
        }

        // The site's own build, on the restored sources, vouches again.
        runSteps(root, [site.step]);
        const rebuilt = await lane(root, site.lane);
        assert.equal(rebuilt.decision, "none", rebuilt.report);
      }));
  }

  test("builds: an engine built with its debug pragmas stripped is never served by the lane that serves them kept", () =>
    withBuildSandbox(async (root) => {
      runSteps(root, [["planFull", { workspace: "engine" }]]);
      assert.equal((await lane(root, "engine")).decision, "none");

      // `gulp build --removePragmas` runs buildEngine with the option.
      runSteps(root, [["buildEngine", { removePragmas: true }]]);
      const stripped = await lane(root, "engine");
      assert.equal(stripped.decision, "full", stripped.report);
      const workers = stripped.records.find(
        (check) => check.descriptor.kind === "engine-workers",
      );
      assert.equal(workers.comparison.reason, "flavour-mismatch");
      assert.deepEqual(workers.comparison.recordedFlavour, {
        minify: false,
        removePragmas: true,
      });
      assert.deepEqual(workers.comparison.expectedFlavour, {
        minify: false,
        removePragmas: false,
      });
      assert.ok(
        stripped.report.includes("removePragmas=true") &&
          stripped.report.includes("removePragmas=false"),
        stripped.report,
      );
      assert.equal(stripped.spec.fresh, true, "only the flavour differs");

      // The lane's own full build writes the flavour it serves.
      runSteps(root, [["planFull", { workspace: "engine" }]]);
      assert.equal((await lane(root, "engine")).decision, "none");
    }));

  test("builds: an engine module added after the earlier build steps generated the barrels is bundled into Cesium.js and hashed into its records", () =>
    withBuildSandbox(async (root) => {
      const added = "packages/engine/Source/Core/Added.js";
      runSteps(root, [
        ["buildEngine", {}],
        ["buildWidgets", {}],
        // A file added between two steps of one task: the barrels on disk
        // were generated before it existed.
        ["write", added, engineMarker("ADDED")],
        ["buildCesium", { iife: true, clean: false }],
      ]);

      assert.ok(
        read(root, `${OUT_DEFAULT}/Cesium.js`).includes("ENGINE-ADDED"),
        "Cesium.js bundles the added module",
      );
      assert.ok(read(root, "packages/engine/index.js").includes("Added.js"));
      for (const descriptor of [
        outputRecord(OUT_DEFAULT, DEVELOPMENT),
        specRecord("combined"),
      ]) {
        const check = await recordCheck(root, descriptor);
        assert.equal(check.comparison.fresh, true, descriptor.label);
        assert.ok(
          JSON.stringify(check.recorded).includes(added),
          `${descriptor.label} hashes the added module`,
        );
      }
    }));

  // The combined bundle resolves a spec's `index.js` import to the Cesium
  // global the browser loads (externalResolvePlugin), so it inlines no package
  // barrel: whatever the barrels on disk say, its bytes are the same.
  test("builds: the combined spec bundle is the same, byte for byte, whatever the package barrels on disk say, and its record is fresh", () =>
    withBuildSandbox(async (root) => {
      const bundleFiles = () => {
        /** @type {Map<string, Buffer>} */
        const files = new Map();
        const walk = (directory) => {
          for (const entry of fs.readdirSync(path.join(root, directory), {
            withFileTypes: true,
          })) {
            const relative = `${directory}/${entry.name}`;
            if (entry.isDirectory()) {
              if (entry.name !== "TestWorkers") {
                walk(relative);
              }
            } else if (!entry.name.endsWith(".meta.json")) {
              files.set(relative, readBytes(root, relative));
            }
          }
        };
        walk("Build/Specs");
        return files;
      };
      const assertSameBundle = (before, label) => {
        const after = bundleFiles();
        assert.deepEqual(
          [...after.keys()].sort(),
          [...before.keys()].sort(),
          `${label}: the bundle's files`,
        );
        for (const [name, bytes] of before) {
          assert.ok(
            bytes.equals(after.get(name)),
            `${label}: ${name} differs from the first build's bytes`,
          );
        }
      };
      const engineBarrel = "packages/engine/index.js";
      const widgetsBarrel = "packages/widgets/index.js";

      // The barrels as two builds leave them, then the combined bundle.
      runSteps(root, [
        ["buildEngine", {}],
        ["buildWidgets", {}],
        ["buildCombinedSpecBundle", {}],
      ]);
      const first = bundleFiles();
      assert.ok(first.has("Build/Specs/SpecList.js"), "the bundle is written");

      // A barrel another build leaves with a name changed: the widgets
      // barrel's Viewer is no longer the module the specs were written
      // against.
      const viewerLine = /export \{ default as Viewer \} from [^\r\n]*/;
      const widgetsOnDisk = read(root, widgetsBarrel);
      assert.ok(
        viewerLine.test(widgetsOnDisk),
        "the widgets barrel names Viewer",
      );
      writeAt(
        root,
        widgetsBarrel,
        widgetsOnDisk.replace(
          viewerLine,
          'export const Viewer = "BARREL-ON-DISK";',
        ),
      );
      runSteps(root, [["buildCombinedSpecBundle", {}]]);
      assert.ok(
        read(root, widgetsBarrel).includes("BARREL-ON-DISK"),
        "the rebuild leaves the widgets barrel as it found it",
      );
      assertSameBundle(first, "a widgets barrel that names another Viewer");

      // A barrel another build leaves without a module name a spec imports.
      const markerLine = /export \{ default as Marker \} from [^\r\n]*\r?\n/;
      const engineOnDisk = read(root, engineBarrel);
      assert.ok(
        markerLine.test(engineOnDisk),
        "the engine barrel names Marker",
      );
      writeAt(root, engineBarrel, engineOnDisk.replace(markerLine, ""));
      runSteps(root, [["buildCombinedSpecBundle", {}]]);
      assert.ok(
        !/default as Marker\b/.test(read(root, engineBarrel)),
        "the rebuild leaves the engine barrel as it found it",
      );
      assertSameBundle(first, "an engine barrel without Marker");

      const check = await recordCheck(root, specRecord("combined"));
      assert.equal(
        check.comparison.fresh,
        true,
        "the combined record is fresh",
      );
    }));
});
