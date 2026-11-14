// RUNNER REQUIREMENT: Node >= 22.18. This spec statically imports `.ts` modules
// (WebGPUCloudMarchFeatures.ts, WebGPUPipelineRequestGuard.ts), which relies on
// Node's built-in type stripping (on by default from Node 22.18).
// @purpose Pins that the cloud march pipeline request built from a CloudMarchFeatures object is observably identical to the positional-argument request it replaced: same pipeline-cache key, definesHi for the module cache and the pipeline descriptor, fragment entry point and colour-target formats, and the same variant sequence from selectCloudMarchPipeline, over a sweep of emit, preview, moments, primary reuse, cache state and format; the base answers are captured from the base revision, never typed.
// @status ACTIVE
//
// HOW IT WORKS. The base revision's requestCloudMarchPipeline /
// selectCloudMarchPipeline (positional arguments) and the worktree's (features
// object) are each sliced out of WebGPUProceduralCloudRenderer.ts, transformed
// with esbuild and run in node:vm with fakes. Both are driven over the same
// enumerated cases and every observable request is recorded as a string.
//
// CAPTURE MODE. `CLOUD_MARCH_FEATURES_CAPTURE=1 node --test <this spec>` reads
// the base renderer through `git show <baseRevision>:<path>`, runs the sweep on
// it and writes fixtures/cloud-march-features-base.json (with the base
// revision and the renderer blob id). Normal mode reads only that fixture and
// the worktree, so it runs in a folder with no `.git`.
//
// WHAT IT CATCHES. A feature bit that stops reaching the defines (the moments
// bit made unreachable, the preview or primary-reuse mask dropped, the
// moments-off fallback of the progressive ladder removed) or a changed default
// when the features argument is omitted. The mutant tests below load the
// worktree code with each of those made unreachable and require the
// comparison to go red. Later features added to CloudMarchFeatures stay
// green as long as a request that names none of them behaves as the base did.
//
// THE LIVE FEATURES. The base sweep never sets a cache flag a later feature
// reads, so the features themselves are pinned separately, for every field
// `cloudMarchActiveFeatures` returns: the cache flag that reports the feature
// live puts exactly its define into the request the renderer builds by default
// and into the variant `selectCloudMarchPipeline` returns; each rung of the
// fallback ladder returns the variant without its feature when only that one
// is ready, after requesting the documented sequence; and with nothing ready
// the ladder requests every rung in order. Each of those is made unreachable
// in turn (the field read in `cloudMarchActiveFeatures`, each rung's branch)
// and the matching test must go red.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import { shaderDefines } from "./lib/wgsl-variant.mjs";

// Imported after wgsl-variant.mjs has run: the engine .ts modules name their
// siblings with a .js suffix, which that module's resolution hook maps back.
const featuresModule =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudMarchFeatures.ts");
const { WebGPUPipelineRequestGuard } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUPipelineRequestGuard.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const BASE_REVISION = "85bcb89ff23edf5b170e8f896d885efee8e61812";
const RENDERER_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts";
const FEATURES_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudMarchFeatures.ts";
const FIXTURE = path.join(here, "fixtures", "cloud-march-features-base.json");
const CAPTURE = process.env.CLOUD_MARCH_FEATURES_CAPTURE === "1";
const { ShaderDefineHi, ShaderSourceId } = shaderDefines;

const FORMATS = ["rgba16float", "bgra8unorm"];
const MODES = ["pending", "sync", "async"];

function lf(text) {
  return text.replace(/\r\n/g, "\n");
}

function replaceOnce(source, anchor, replacement) {
  const count = source.split(anchor).length - 1;
  assert.equal(count, 1, `anchor must occur once, found ${count}: ${anchor}`);
  return source.replace(anchor, () => replacement);
}

function sliceMarchFunctions(renderer) {
  const begin = renderer.indexOf("function requestCloudMarchPipeline(");
  const end = renderer.indexOf("function initializeCloudPipeline(", begin);
  assert(
    begin >= 0 && end > begin,
    "march functions not found in the renderer",
  );
  return renderer.slice(begin, end);
}

function worktreeRenderer() {
  return lf(fs.readFileSync(path.join(root, RENDERER_PATH), "utf8"));
}

function baseRenderer() {
  const run = (args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  return {
    source: lf(run(["show", `${BASE_REVISION}:${RENDERER_PATH}`])),
    blob: run(["rev-parse", `${BASE_REVISION}:${RENDERER_PATH}`]).trim(),
  };
}

// The features module, run from source with anchor replacements applied: the
// module is TypeScript, so it goes through esbuild rather than a data: import.
async function mutatedFeatures(replacements) {
  let source = lf(fs.readFileSync(path.join(root, FEATURES_PATH), "utf8"));
  for (const [anchor, replacement] of replacements) {
    source = replaceOnce(source, anchor, replacement);
  }
  const { code } = await transform(source, { loader: "ts", format: "cjs" });
  const module = { exports: {} };
  runInNewContext(code, {
    exports: module.exports,
    module,
    require: (specifier) => {
      assert.equal(specifier, "./WebGPUShaderDefines.js");
      return { ShaderDefineHi };
    },
  });
  return { ...module.exports };
}

const state = { log: null, modules: null };

class FakeModules {
  getOrCreate(sourceId, source, bits, label, extra, hi) {
    state.log.modules.push(hi);
    if (!state.modules.has(hi)) {
      state.modules.set(hi, {});
    }
    return state.modules.get(hi);
  }
}

// Builds the two entry points from a renderer's march functions. `features` is
// the features module's exports spread into the sandbox (absent for the base,
// which has none).
async function buildHarness(marchSource, features) {
  const { code } = await transform(marchSource, {
    loader: "ts",
    format: "cjs",
  });
  const sandbox = {
    ...(features ?? {}),
    WebGPUShaderModuleCache: FakeModules,
    performance: globalThis.performance,
    ShaderDefineHi,
    ShaderSourceId,
    CLOUD_QF_NOISE_BAKED: 1,
    CLOUD_MARCH_EMIT_DEFINES_HI: ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION,
    CLOUD_MARCH_EMITTED_FORMAT: "rg32float",
    PROCEDURAL_CLOUDS_SOURCE: "fixture",
    CLOUD_TEMPORAL_RESET_RESOURCE: 8,
    console,
  };
  return runInNewContext(
    `${code}\n({request: requestCloudMarchPipeline, select: selectCloudMarchPipeline});`,
    sandbox,
  );
}

// One call adapter per argument convention. `args` is {preview, moments,
// primary}; `moments` and `primary` may be undefined (not passed).
function positionalCall(fns, context, cache, format, emit, args) {
  return fns.request(
    context,
    cache,
    format,
    emit,
    args.preview,
    args.moments,
    args.primary,
  );
}

// The same request in the features-object convention. A request that passes
// nothing leaves the argument off, so the default is exercised; otherwise the
// object starts from the cache's active features, as the base's default
// `moments` did, and the named fields override them.
function featuresCaller(featuresExports) {
  return (fns, context, cache, format, emit, args) => {
    if (
      args.preview === false &&
      args.moments === undefined &&
      args.primary === undefined
    ) {
      return fns.request(context, cache, format, emit);
    }
    const features = {
      ...featuresExports.cloudMarchActiveFeatures(cache),
      preview: args.preview,
    };
    if (args.moments !== undefined) {
      features.moments = args.moments;
    }
    if (args.primary !== undefined) {
      features.primaryReuseDefinesHi = args.primary;
    }
    return fns.request(context, cache, format, emit, features);
  };
}

const MORPHOLOGY_SLOTS = [
  [],
  [[75, 0.2]],
  [[128, 0.5]],
  [
    [132, 2],
    [133, 1],
  ],
  [
    [132, 2],
    [133, 0],
  ],
  [
    [132, 0.4],
    [133, 1],
  ],
  [
    [136, 1],
    [137, 1],
  ],
  [
    [140, 1],
    [141, 1],
  ],
  [[168, 0.4]],
];

function cacheStates() {
  const states = [];
  for (const bake of [false, true]) {
    for (const slots of MORPHOLOGY_SLOTS) {
      for (const wind of [undefined, true]) {
        for (const dme of [undefined, false, true]) {
          states.push({ bake, slots, wind, dme });
        }
      }
    }
  }
  return states;
}

function requestCases() {
  const cases = [];
  const primaries = [
    undefined,
    0,
    ShaderDefineHi.CLOUD_DENSITY_MOMENTS |
      ShaderDefineHi.CLOUD_NOISE_BAKED_ONLY,
    ShaderDefineHi.CLOUD_NOISE_BAKED_ONLY |
      ShaderDefineHi.CLOUD_MORPHOLOGY_BASE_ONLY |
      ShaderDefineHi.CLOUD_GEOGRAPHIC_WIND,
  ];
  for (const cacheState of cacheStates()) {
    for (const emit of [false, true]) {
      for (const preview of [false, true]) {
        for (const moments of [undefined, false, true]) {
          for (const primary of primaries) {
            for (const format of FORMATS) {
              for (const mode of MODES) {
                cases.push({
                  kind: "request",
                  cacheState,
                  emit,
                  args: { preview, moments, primary },
                  format,
                  mode,
                });
              }
            }
          }
        }
      }
    }
  }
  return cases;
}

const SELECT_SCENARIOS = [
  "none",
  "all",
  "previewOnly",
  "momentsOff",
  "momentsOnly",
  "asyncAll",
];

function selectCases() {
  const cases = [];
  const states = [
    { bake: false, slots: [], wind: undefined },
    { bake: true, slots: [], wind: undefined },
    { bake: true, slots: [], wind: true },
    { bake: true, slots: [[75, 0.2]], wind: undefined },
  ];
  for (const base of states) {
    for (const dme of [undefined, false, true]) {
      for (const progressive of [false, true]) {
        for (const previewDrawn of [false, true]) {
          for (const format of FORMATS) {
            for (const scenario of SELECT_SCENARIOS) {
              cases.push({
                kind: "select",
                cacheState: { ...base, dme },
                progressive,
                previewDrawn,
                format,
                scenario,
              });
            }
          }
        }
      }
    }
  }
  return cases;
}

function allCases() {
  return [...requestCases(), ...selectCases()];
}

function caseId(c) {
  return JSON.stringify(c, (_key, value) =>
    value === undefined ? "undefined" : value,
  );
}

function makeCache(spec, previewDrawn = false) {
  const data = new Float32Array(176);
  data[74] = spec.bake ? 1 : 0;
  for (const [index, value] of spec.slots) {
    data[index] = value;
  }
  return {
    uniformData: data,
    bindGroupLayout: {},
    marchPipelines: new Map(),
    marchRequestGuard: new WebGPUPipelineRequestGuard(),
    marchModules: null,
    marchPipelineLayout: null,
    startupPreviewDrawn: previewDrawn,
    usingStartupPreview: false,
    temporalHistoryPendingResetReasons: 0,
    densityMomentsEnabled: spec.dme,
    geographicWindRequested: spec.wind,
    maskPipeline: {},
    shadowPipeline: {},
    ...(spec.flags ?? {}),
  };
}

function describeDescriptor(d, cache) {
  return {
    name: d.name,
    definesHi: d.definesHi,
    vertex: d.vertex.entryPoint,
    entry: d.fragment.entryPoint,
    targets: d.fragment.targets.map((t) => t.format),
    topology: d.primitive.topology,
    layout: d.layout === cache.marchPipelineLayout,
  };
}

function makeContext(cache, log, readyFor, resolves) {
  return {
    _device: {
      createPipelineLayout: () => {
        log.layouts++;
        return {};
      },
    },
    _cloudCache: cache,
    webgpuPipelineCache: {
      getPipelineSync: (d) => {
        log.sync.push(describeDescriptor(d, cache));
        return readyFor(d.definesHi) ? { id: d.definesHi } : undefined;
      },
      getPipeline: (d) => {
        log.async.push(describeDescriptor(d, cache));
        return resolves
          ? Promise.resolve({ id: `async${d.definesHi}` })
          : new Promise(() => {});
      },
    },
  };
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

function freshLog() {
  state.log = { modules: [], sync: [], async: [], layouts: 0 };
  state.modules = new Map();
  return state.log;
}

function cacheSnapshot(cache) {
  return {
    entries: Array.from(cache.marchPipelines, ([key, value]) => [
      key,
      value ? value.id : null,
    ]),
    selectedDefinesHi: cache.selectedMarchDefinesHi,
    maskIsSelectedModule:
      cache.maskShaderModule !== undefined &&
      cache.maskShaderModule ===
        state.modules.get(cache.selectedMarchDefinesHi),
    maskPipelineReset: cache.maskPipeline === null,
    shadowPipelineReset: cache.shadowPipeline === null,
  };
}

async function observeRequest(fns, call, c) {
  const cache = makeCache(c.cacheState);
  const log = freshLog();
  const context = makeContext(
    cache,
    log,
    () => c.mode === "sync",
    c.mode === "async",
  );
  const first = call(fns, context, cache, c.format, c.emit, c.args);
  await settle();
  const second = call(fns, context, cache, c.format, c.emit, c.args);
  await settle();
  return JSON.stringify({
    first: first ? first.id : null,
    second: second ? second.id : null,
    log,
    cache: cacheSnapshot(cache),
  });
}

function scenarioReady(scenario) {
  const preview = ShaderDefineHi.CLOUD_LIGHTING_PREVIEW;
  const moments = ShaderDefineHi.CLOUD_DENSITY_MOMENTS;
  switch (scenario) {
    case "all":
      return () => true;
    case "previewOnly":
      return (hi) => (hi & preview) !== 0;
    case "momentsOff":
      return (hi) => (hi & (preview | moments)) === 0;
    case "momentsOnly":
      return (hi) => (hi & moments) !== 0 && (hi & preview) === 0;
    default:
      return () => false;
  }
}

async function observeSelect(fns, c) {
  const cache = makeCache(c.cacheState, c.previewDrawn);
  const log = freshLog();
  const context = makeContext(
    cache,
    log,
    scenarioReady(c.scenario),
    c.scenario === "asyncAll",
  );
  const steps = [];
  for (let step = 0; step < 4; step++) {
    if (step === 2) {
      cache.startupPreviewDrawn = true;
    }
    const before = {
      modules: log.modules.length,
      sync: log.sync.length,
      async: log.async.length,
    };
    const pipeline = fns.select(context, cache, c.format, c.progressive);
    steps.push({
      returned: pipeline ? pipeline.id : null,
      variants: log.modules.slice(before.modules),
      sync: log.sync.slice(before.sync),
      async: log.async.slice(before.async),
      usingStartupPreview: cache.usingStartupPreview,
      resetReasons: cache.temporalHistoryPendingResetReasons,
      isSelected: pipeline === cache.selectedMarchPipeline,
      cache: cacheSnapshot(cache),
    });
    await settle();
  }
  return JSON.stringify({ steps });
}

async function observeAll(fns, call) {
  const cases = allCases();
  const observations = [];
  for (const c of cases) {
    observations.push(
      c.kind === "request"
        ? await observeRequest(fns, call, c)
        : await observeSelect(fns, c),
    );
  }
  return { cases, observations };
}

function caseDigest(cases) {
  const hash = createHash("sha256");
  for (const c of cases) {
    hash.update(caseId(c)).update("\n");
  }
  return hash.digest("hex");
}

// The sweep repeats a small set of distinct answers, so the fixture stores each
// distinct observation once and one table index per case.
function packObservations(observations) {
  const table = [];
  const index = new Map();
  const outcomes = observations.map((text) => {
    if (!index.has(text)) {
      index.set(text, table.length);
      table.push(text);
    }
    return index.get(text);
  });
  return { table, outcomes };
}

function readFixture() {
  assert(
    fs.existsSync(FIXTURE),
    "fixture missing: run with CLOUD_MARCH_FEATURES_CAPTURE=1 to capture it from the base revision",
  );
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
}

function mismatches(fixture, observations) {
  const found = [];
  for (let i = 0; i < observations.length; i++) {
    if (fixture.observations[fixture.outcomes[i]] !== observations[i]) {
      found.push(i);
    }
  }
  return found;
}

async function worktreeObservations(featuresExports, rendererSource) {
  const fns = await buildHarness(
    sliceMarchFunctions(rendererSource ?? worktreeRenderer()),
    featuresExports,
  );
  return observeAll(fns, featuresCaller(featuresExports));
}

function requestedVariants(observation) {
  const parsed = JSON.parse(observation);
  return parsed.steps
    ? parsed.steps.flatMap((step) => step.variants)
    : parsed.log.modules;
}

if (CAPTURE) {
  test("capture the base revision's march requests into the fixture", async () => {
    const { source, blob } = baseRenderer();
    const fns = await buildHarness(sliceMarchFunctions(source), undefined);
    const { cases, observations } = await observeAll(fns, positionalCall);
    const { table, outcomes } = packObservations(observations);
    fs.writeFileSync(
      FIXTURE,
      JSON.stringify({
        baseRevision: BASE_REVISION,
        rendererPath: RENDERER_PATH,
        rendererBlob: blob,
        capturedBy:
          "CLOUD_MARCH_FEATURES_CAPTURE=1 node --test Tools/visual-regression/cloud-march-features.spec.mjs",
        caseCount: cases.length,
        caseDigest: caseDigest(cases),
        observations: table,
        outcomes,
      }) + "\n",
    );
  });
}

test("the fixture was captured from the base revision over the cases this spec enumerates", () => {
  const fixture = readFixture();
  assert.equal(fixture.baseRevision, BASE_REVISION);
  assert.match(fixture.rendererBlob, /^[0-9a-f]{40}$/);
  const cases = allCases();
  assert.equal(fixture.caseCount, cases.length);
  assert.equal(fixture.outcomes.length, cases.length);
  assert.equal(
    fixture.caseDigest,
    caseDigest(cases),
    "the case enumeration changed: recapture the fixture",
  );
});

test("the sweep is not degenerate: the base fixture reaches every entry point, target list and define bit", () => {
  const fixture = readFixture();
  const text = fixture.observations.join("\n");
  assert(text.includes('"entry":"fragmentCloudPrimaryMain"'));
  assert(text.includes('"entry":"fragmentMain"'));
  assert(text.includes('"targets":["rgba16float","rg32float"]'));
  assert(text.includes('"targets":["bgra8unorm","r8unorm","rg32float"]'));
  const variants = fixture.observations.flatMap(requestedVariants);
  for (const bit of [
    "CLOUD_DENSITY_MOMENTS",
    "CLOUD_LIGHTING_PREVIEW",
    "CLOUD_GEOGRAPHIC_WIND",
    "CLOUD_MORPHOLOGY_BASE_ONLY",
    "CLOUD_NOISE_BAKED_ONLY",
    "CLOUD_PRIMARY_REUSE",
    "CLOUD_MARCH_EMIT_RECONSTRUCTION",
  ]) {
    assert(
      variants.some((hi) => (hi & ShaderDefineHi[bit]) !== 0),
      `no base observation requests ${bit}`,
    );
  }
  assert(fixture.observations.length > 100);
});

test("the features-object request matches the base's positional request over the full sweep", async () => {
  const fixture = readFixture();
  const { cases, observations } = await worktreeObservations(featuresModule);
  assert.equal(cases.length, fixture.caseCount);
  const bad = mismatches(fixture, observations);
  assert.deepEqual(
    bad.slice(0, 3).map((i) => ({
      case: caseId(cases[i]),
      base: fixture.observations[fixture.outcomes[i]],
      now: observations[i],
    })),
    [],
    `${bad.length} of ${cases.length} cases differ from the base`,
  );
});

test("mutant: the moments bit made unreachable in cloudMarchFeatureDefines is detected", async () => {
  const fixture = readFixture();
  const mutated = await mutatedFeatures([
    ["features.moments ?", "false && features.moments ?"],
  ]);
  const { observations } = await worktreeObservations(mutated);
  assert(
    mismatches(fixture, observations).length > 0,
    "the comparison did not notice the dead moments bit",
  );
});

test("mutant: the cache's active features made unreachable is detected", async () => {
  const fixture = readFixture();
  const mutated = await mutatedFeatures([
    [
      "moments: cache.densityMomentsEnabled ?? false,",
      "moments: false && (cache.densityMomentsEnabled ?? false),",
    ],
  ]);
  const { observations } = await worktreeObservations(mutated);
  assert(mismatches(fixture, observations).length > 0);
});

const RENDERER_MUTANTS = [
  [
    "the preview flag",
    "const preview = features.preview === true;",
    "const preview = false && features.preview === true;",
  ],
  [
    "the primary-reuse request",
    "const primaryReuse = primaryReuseDefinesHi !== undefined;",
    "const primaryReuse = false && primaryReuseDefinesHi !== undefined;",
  ],
  [
    "the emit defines",
    "(emit ? CLOUD_MARCH_EMIT_DEFINES_HI : 0)",
    "(false && emit ? CLOUD_MARCH_EMIT_DEFINES_HI : 0)",
  ],
  [
    "the moments-off fallback of the progressive ladder",
    "if (!pipeline && !preview && active.moments) {",
    "if (false && !pipeline && !preview && active.moments) {",
  ],
  [
    "the preview fallback request",
    "if (!pipeline && progressive) {",
    "if (false && !pipeline && progressive) {",
  ],
];

for (const [name, anchor, replacement] of RENDERER_MUTANTS) {
  test(`mutant: ${name} made unreachable in the renderer is detected`, async () => {
    const fixture = readFixture();
    const source = replaceOnce(worktreeRenderer(), anchor, replacement);
    const { observations } = await worktreeObservations(featuresModule, source);
    assert(
      mismatches(fixture, observations).length > 0,
      `the comparison did not notice ${name} made unreachable`,
    );
  });
}

// Each optional feature the cache can report turns on exactly its own define,
// and nothing when the preview is drawn. The fields come from the features
// module itself (`cloudMarchActiveFeatures`), so a feature added later is
// checked as soon as it exists; one this table does not name fails the test.
const FEATURE_DEFINES = {
  moments: { define: "CLOUD_DENSITY_MOMENTS", needs: [] },
  spatial: { define: "CLOUD_SPATIAL_OCCUPANCY", needs: [] },
  bounds: { define: "CLOUD_WEATHER_VOLUME_BOUNDS", needs: ["spatial"] },
  density: { define: "CLOUD_DENSITY_SAMPLE_CACHE", needs: [] },
  primary: { define: "CLOUD_PRIMARY_DENSITY_CACHE", needs: ["density"] },
  deep: { define: "CLOUD_DEEP_SHADOW_CACHE", needs: [] },
  directional: { define: "CLOUD_DIRECTIONAL_LIGHTING", needs: [] },
  contribution: { define: "CLOUD_CONTRIBUTION_LIGHTING", needs: [] },
  transition: { define: "CLOUD_WEATHER_TRANSITION", needs: [] },
  vertical: { define: "CLOUD_WEATHER_VERTICAL", needs: [] },
  populations: { define: "CLOUD_WEATHER_POPULATIONS", needs: [] },
};

// The definesHi each live feature adds to a request, measured through the
// renderer's own request on the fake pipeline cache.
async function featureBits(featuresExports) {
  const fns = await buildHarness(
    sliceMarchFunctions(worktreeRenderer()),
    featuresExports,
  );
  const definesOf = async (features) => {
    const cache = makeCache({ bake: true, slots: [], dme: false, wind: false });
    const log = freshLog();
    const context = makeContext(cache, log, () => true, false);
    fns.request(context, cache, "rgba16float", false, features);
    await settle();
    return log.sync.at(-1).definesHi;
  };
  const bits = {};
  for (const field of Object.keys(
    featuresExports.cloudMarchActiveFeatures({}),
  )) {
    const entry = FEATURE_DEFINES[field];
    assert.ok(entry, `live feature "${field}" has no expected define here`);
    const base = Object.fromEntries(entry.needs.map((need) => [need, true]));
    const without = await definesOf({ ...base });
    const withIt = await definesOf({ ...base, [field]: true });
    const previewWith = await definesOf({
      ...base,
      [field]: true,
      preview: true,
    });
    const previewWithout = await definesOf({ ...base, preview: true });
    bits[field] = {
      added: withIt ^ without,
      preview: previewWith ^ previewWithout,
    };
  }
  return bits;
}

test("every live march feature adds exactly its own define, and none under the preview", async () => {
  const bits = await featureBits(featuresModule);
  assert.ok(Object.keys(bits).length > 0, "no live feature was checked");
  for (const [field, { added, preview }] of Object.entries(bits)) {
    assert.equal(
      added,
      ShaderDefineHi[FEATURE_DEFINES[field].define],
      `${field} adds ${FEATURE_DEFINES[field].define}`,
    );
    assert.equal(preview, 0, `${field} compiles nothing into the preview`);
  }
});

test("mutant: each live feature's define dropped from cloudMarchFeatureDefines is detected", async () => {
  const live = Object.keys(featuresModule.cloudMarchActiveFeatures({}));
  for (const field of live) {
    const name = FEATURE_DEFINES[field].define;
    const mutated = await mutatedFeatures([[`ShaderDefineHi.${name}`, "0"]]);
    const bits = await featureBits(mutated);
    assert.notEqual(
      bits[field].added,
      ShaderDefineHi[name],
      `dropping ${name} went unnoticed`,
    );
  }
});

// The cache flag that reports each optional feature live, as the frame sets it
// after the feature's owner prepared.
const FEATURE_CACHE_FLAGS = {
  moments: "densityMomentsEnabled",
  spatial: "spatialOccupancyActive",
  bounds: "weatherBoundsActive",
  density: "densityCacheActive",
  primary: "primaryDensityActive",
  deep: "deepShadowActive",
  directional: "directionalLightingRequested",
  contribution: "contributionLightingActive",
  transition: "weatherTransitionRequested",
  vertical: "weatherVerticalRequested",
  populations: "weatherPopulationsRequested",
};

function liveFields(featuresExports) {
  const fields = Object.keys(featuresExports.cloudMarchActiveFeatures({}));
  for (const field of fields) {
    assert.ok(
      FEATURE_CACHE_FLAGS[field],
      `live feature "${field}" has no cache flag here`,
    );
  }
  return fields;
}

// A field together with the fields it needs before its define applies.
function withNeeds(fields) {
  const all = new Set();
  for (const field of fields) {
    for (const need of FEATURE_DEFINES[field].needs) {
      all.add(need);
    }
    all.add(field);
  }
  return [...all];
}

function cacheFlags(fields) {
  return Object.fromEntries(
    fields.map((field) => [FEATURE_CACHE_FLAGS[field], true]),
  );
}

const PLAIN_CACHE = { bake: true, slots: [], dme: undefined, wind: undefined };

// The definesHi each live feature's cache flag puts into the default request
// and into the variant select returns, with every pipeline ready.
async function cacheFlagBits(featuresExports, rendererSource) {
  const fns = await buildHarness(
    sliceMarchFunctions(rendererSource ?? worktreeRenderer()),
    featuresExports,
  );
  const observe = async (fields) => {
    const requestCache = makeCache({
      ...PLAIN_CACHE,
      flags: cacheFlags(fields),
    });
    let log = freshLog();
    fns.request(
      makeContext(requestCache, log, () => true, false),
      requestCache,
      "rgba16float",
      false,
    );
    await settle();
    const request = log.sync.at(-1).definesHi;
    const selectCache = makeCache({
      ...PLAIN_CACHE,
      flags: cacheFlags(fields),
    });
    log = freshLog();
    const selected = fns.select(
      makeContext(selectCache, log, () => true, false),
      selectCache,
      "rgba16float",
      false,
    );
    await settle();
    return { request, select: selected ? selected.id : null };
  };
  const bits = {};
  for (const field of liveFields(featuresExports)) {
    const needs = FEATURE_DEFINES[field].needs;
    const without = await observe(needs);
    const withIt = await observe([...needs, field]);
    bits[field] = {
      request: withIt.request ^ without.request,
      select:
        withIt.select === null || without.select === null
          ? null
          : withIt.select ^ without.select,
    };
  }
  return bits;
}

function cacheFlagMismatches(bits) {
  const wrong = [];
  for (const [field, { request, select }] of Object.entries(bits)) {
    const expected = ShaderDefineHi[FEATURE_DEFINES[field].define];
    if (request !== expected || select !== expected) {
      wrong.push(
        `${field}: request ${request}, select ${select}, want ${expected}`,
      );
    }
  }
  return wrong;
}

test("each live feature's cache flag puts exactly its define into the default request and the selected variant", async () => {
  const bits = await cacheFlagBits(featuresModule);
  assert.ok(Object.keys(bits).length > 0, "no live feature was checked");
  assert.deepEqual(cacheFlagMismatches(bits), []);
});

test("mutant: each live feature's cache flag made unreachable in cloudMarchActiveFeatures is detected", async () => {
  for (const field of liveFields(featuresModule)) {
    const flag = FEATURE_CACHE_FLAGS[field];
    const mutated = await mutatedFeatures([
      [
        `${field}: cache.${flag} ?? false,`,
        `${field}: false && (cache.${flag} ?? false),`,
      ],
    ]);
    const wrong = cacheFlagMismatches(await cacheFlagBits(mutated));
    assert.ok(
      wrong.some((line) => line.startsWith(`${field}:`)),
      `the dead ${flag} read went unnoticed`,
    );
  }
});

// The fallback ladder of selectCloudMarchPipeline, in order: a rung runs when
// every field it names is live and active and no earlier request was ready,
// and requests the active features with the fields it drops turned off. The
// last rung is nested in the spatial rung, so it follows it directly.
const LADDER = [
  { when: ["contribution"], drops: ["contribution"] },
  { when: ["primary"], drops: ["primary"] },
  { when: ["deep"], drops: ["deep"] },
  { when: ["density"], drops: ["density", "deep"] },
  { when: ["moments"], drops: ["moments", "density", "deep"] },
  { when: ["spatial"], drops: ["spatial", "density", "deep"] },
  {
    when: ["spatial", "moments"],
    drops: ["spatial", "moments", "density", "deep"],
    anchor: "if (!pipeline && active.moments) {",
  },
];

function rungAnchor(rung) {
  return (
    rung.anchor ?? `if (!pipeline && !preview && active.${rung.when[0]}) {`
  );
}

// The definesHi a request for `features` compiles, built from the expected
// define table rather than from cloudMarchFeatureDefines.
function expectedDefines(base, live, features) {
  let hi = base;
  for (const field of live) {
    const { define, needs } = FEATURE_DEFINES[field];
    if (features[field] && needs.every((need) => features[need])) {
      hi |= ShaderDefineHi[define];
    }
  }
  return hi;
}

// The requests the documented ladder makes for `active`, stopping at the first
// ready variant, and the variant it returns.
function expectedLadder(base, live, active, ready) {
  const requested = [expectedDefines(base, live, active)];
  if (ready(requested[0])) {
    return { requested, returned: requested[0] };
  }
  for (const rung of LADDER) {
    if (!rung.when.every((field) => live.includes(field) && active[field])) {
      continue;
    }
    const features = { ...active };
    for (const field of rung.drops) {
      features[field] = false;
    }
    const hi = expectedDefines(base, live, features);
    requested.push(hi);
    if (ready(hi)) {
      return { requested, returned: hi };
    }
  }
  return { requested, returned: null };
}

function liveRungs(live) {
  return LADDER.filter((rung) =>
    rung.when.every((field) => live.includes(field)),
  );
}

// Runs one select over a cache whose live flags are `fields`, with `ready`
// deciding which variants the fake pipeline cache has, against the documented
// ladder. Returns the differences.
async function ladderDifferences(fns, live, fields, ready) {
  const cache = makeCache({ ...PLAIN_CACHE, flags: cacheFlags(fields) });
  const log = freshLog();
  const returned = fns.select(
    makeContext(cache, log, ready, false),
    cache,
    "rgba16float",
    false,
  );
  await settle();
  const base = log.modules[0] & ~featureMask(live);
  const active = Object.fromEntries(fields.map((field) => [field, true]));
  const expected = expectedLadder(base, live, active, ready);
  const observed = {
    requested: log.modules,
    returned: returned ? returned.id : null,
  };
  return JSON.stringify(observed) === JSON.stringify(expected)
    ? null
    : `fields ${fields.join("+")}: ${JSON.stringify(observed)} != documented ${JSON.stringify(expected)}`;
}

function featureMask(live) {
  return live.reduce(
    (mask, field) => mask | ShaderDefineHi[FEATURE_DEFINES[field].define],
    0,
  );
}

// Per rung: only variants without the rung's features are ready, so the ladder
// must reach that rung and return its variant.
async function rungDifferences(rendererSource) {
  const fns = await buildHarness(
    sliceMarchFunctions(rendererSource ?? worktreeRenderer()),
    featuresModule,
  );
  const live = liveFields(featuresModule);
  const found = {};
  for (const rung of liveRungs(live)) {
    const fields = withNeeds(rung.when);
    const without = featureMask(rung.when);
    const difference = await ladderDifferences(
      fns,
      live,
      fields,
      (hi) => (hi & without) === 0,
    );
    if (difference) {
      found[rung.when.join("+")] = difference;
    }
  }
  return found;
}

// Every live feature active and nothing ready: the ladder requests every rung.
async function fullLadderDifference(rendererSource) {
  const fns = await buildHarness(
    sliceMarchFunctions(rendererSource ?? worktreeRenderer()),
    featuresModule,
  );
  const live = liveFields(featuresModule);
  return ladderDifferences(fns, live, live, () => false);
}

test("each live rung of the fallback ladder returns the variant without its feature when only that one is ready", async () => {
  const live = liveFields(featuresModule);
  assert.ok(liveRungs(live).length > 0, "no live rung was checked");
  assert.deepEqual(await rungDifferences(), {});
});

test("with every live feature active and nothing ready the ladder requests the documented sequence", async () => {
  assert.equal(await fullLadderDifference(), null);
});

test("mutant: each live rung made unreachable in selectCloudMarchPipeline is detected", async () => {
  const live = liveFields(featuresModule);
  for (const rung of liveRungs(live)) {
    const source = replaceOnce(
      worktreeRenderer(),
      rungAnchor(rung),
      rungAnchor(rung).replace("if (", "if (false && "),
    );
    const name = rung.when.join("+");
    const found = await rungDifferences(source);
    assert.ok(found[name], `the dead ${name} rung went unnoticed per rung`);
    assert.notEqual(
      await fullLadderDifference(source),
      null,
      `the dead ${name} rung went unnoticed in the full ladder`,
    );
  }
});
// Execute the real preparation and late-draw caller slices in the existing VM.
function selectedEmissionBlock(source, marker, from = 0) {
  const start = source.indexOf(marker, from);
  assert(start >= 0, marker);
  const open = source.indexOf("{", start);
  let end = open + 1,
    depth = 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  assert.equal(depth, 0);
  return source.slice(start, end);
}
function selectedEmissionStatement(source, marker, from = 0) {
  const start = source.indexOf(marker, from),
    end = source.indexOf(";", start);
  assert(start >= 0 && end > start, marker);
  return source.slice(start, end + 1);
}
async function selectedEmissionHarness(renderer = worktreeRenderer()) {
  const start = renderer.indexOf("    const marchFormat = halfResActive");
  const end = renderer.indexOf("    if (!marchPipeline) {", start);
  assert(start >= 0 && end > start);
  const preparation = renderer.slice(start, end);
  const gate = selectedEmissionStatement(
    renderer,
    "          const emitReconstruction =",
  );
  const draw = selectedEmissionBlock(
    renderer,
    "          if (!reusedPrimary) {",
    renderer.indexOf(gate),
  );
  // The engine builds the mask and shadow pipelines only while they are
  // absent, so the slices keep those guards: a pipeline survives later frames
  // until the march selection invalidates it.
  const maskBlock = selectedEmissionBlock(
    renderer,
    "  if (\n    requireMaskPipeline &&\n    !cache.maskPipeline &&",
  );
  const shadowBlock = selectedEmissionBlock(
    renderer,
    "  if (!cache.shadowPipeline) {",
  );
  assert(
    maskBlock.includes("cache.maskPipeline = device.createRenderPipeline(") &&
      shadowBlock.includes(
        "cache.shadowPipeline = device.createRenderPipeline(",
      ),
  );
  const constants = ["CLOUD_HALF_FORMAT", "CLOUD_SHADOW_FORMAT"]
    .map((name) => {
      const match = renderer.match(
        new RegExp("const " + name + "[^=]*=[^;]+;"),
      );
      assert(match);
      return match[0];
    })
    .join("\n");
  const extension =
    constants +
    "\n" +
    selectedEmissionBlock(
      renderer,
      "function cloudReconstructionVariantReady(",
    ) +
    String.raw`
const Stage = { FRAGMENT: 2 };
const makeBindGroupLayout = () => ({});
const uniformBuffer = () => ({});
const texture = () => ({});
const sampler = () => ({});
const storageBuffer = () => ({});
const CLOUD_MARCH_EMITTED_SLOT = 1;
const CLOUD_OWNED_ATTACHMENTS = [{clearValue:{r:-1,g:0,b:0,a:0}}];
const timedCloudPass = (_context,descriptor) => descriptor;
requestCloudMarchPipeline.frameCalls = {
  prepare(context,cache,halfResActive,config) { ${preparation} return marchPipeline; },
  draw(context,cache,attachmentsReady,reusedPrimary,encoder,bindGroup) { ${gate} ${draw} return emitReconstruction; },
  nonColor(cache,device,requireMaskPipeline) { ${maskBlock} ${shadowBlock} return {mask:cache.maskPipeline,shadow:cache.shadowPipeline}; },
  primary(context,cache,reuseRequested,reuseEmitDepth) { ${selectedEmissionStatement(renderer, "    const reuseMarchPipeline =")} return reuseMarchPipeline; },
};`;
  const fns = await buildHarness(
    sliceMarchFunctions(renderer) + "\n" + extension,
    featuresModule,
  );
  return { ...fns, frame: fns.request.frameCalls };
}
async function selectedEmissionFixture({
  bake = true,
  retained = false,
  progressive = false,
  preview = false,
  readyActive = false,
  renderer,
} = {}) {
  const fns = await selectedEmissionHarness(renderer),
    cache = makeCache({
      bake,
      slots: [],
      dme: false,
      flags: {
        deepShadowActive: true,
        directionalLightingRequested: retained,
        maskPipeline: null,
        shadowPipeline: null,
      },
    }),
    log = freshLog();
  const plain = bake
    ? ShaderDefineHi.CLOUD_NOISE_BAKED_ONLY |
      ShaderDefineHi.CLOUD_MORPHOLOGY_BASE_ONLY
    : 0;
  const base =
    plain | (retained ? ShaderDefineHi.CLOUD_DIRECTIONAL_LIGHTING : 0);
  const active = base | ShaderDefineHi.CLOUD_DEEP_SHADOW_CACHE,
    emit = ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION,
    primary = ShaderDefineHi.CLOUD_PRIMARY_REUSE,
    gates = new Map();
  const context = makeContext(
    cache,
    log,
    (hi) =>
      hi === (readyActive ? active : base) ||
      (preview && (hi & ShaderDefineHi.CLOUD_LIGHTING_PREVIEW) !== 0) ||
      (hi & primary) !== 0,
    false,
  );
  context.webgpuPipelineCache.getPipeline = (d) => {
    log.async.push(describeDescriptor(d, cache));
    return new Promise((resolve) => {
      assert(!gates.has(d.definesHi), "one pending request per variant");
      gates.set(d.definesHi, resolve);
    });
  };
  context._device.createRenderPipeline = (descriptor) => ({ descriptor });
  Object.assign(cache, {
    reconstructionEnabled: true,
    attachmentEmitPipeline: {},
    attachmentEmitBindGroup: {},
    attachmentViews: [{}],
    halfView: {},
  });
  const config = { cloudProgressiveStartup: progressive };
  function release(hi) {
    const resolve = gates.get(hi);
    assert(resolve, "requested variant " + hi);
    gates.delete(hi);
    resolve({ id: hi });
  }
  function frame(half = true, reusedPrimary = false) {
    const ordinary = fns.frame.prepare(context, cache, half, config),
      calls = [],
      drawCalls = [],
      passes = [];
    const encoder = {
      beginRenderPass: (d) => {
        passes.push(d);
        return {
          setPipeline: (p) => calls.push(p),
          setBindGroup() {},
          draw: (n) => {
            drawCalls.push(n);
            assert.equal(n, 3);
          },
          end() {},
        };
      },
    };
    const nonColor = fns.frame.nonColor(cache, context._device, true);
    const emitted =
      half && ordinary
        ? fns.frame.draw(context, cache, true, reusedPrimary, encoder, {})
        : false;
    const selected = cache.selectedMarchDefinesHi;
    return {
      ordinary: ordinary?.id ?? null,
      selected,
      visible: calls[0]?.id ?? null,
      pipelineSets: calls.length,
      draws: drawCalls.length,
      drawCalls,
      emitted,
      targets: passes[0]?.colorAttachments.length ?? 0,
      halfEmit: cache.halfEmitPipeline?.id ?? null,
      maskModule: nonColor.mask.descriptor.fragment.module,
      shadowModule: nonColor.shadow.descriptor.fragment.module,
      selectedModule: state.modules.get(selected),
      requestedStillActive: cache.deepShadowActive,
      retainedStillRequested:
        !retained || cache.directionalLightingRequested === true,
      halfPipeline: cache.halfPipeline?.id ?? null,
      fullPipeline: cache.pipeline?.id ?? null,
    };
  }
  return {
    fns,
    cache,
    context,
    log,
    plain,
    retained,
    base,
    active,
    emit,
    primary,
    release,
    frame,
  };
}
async function selectedEmissionTrace(bake, renderer, retained = false) {
  const f = await selectedEmissionFixture({ bake, renderer, retained });
  if (retained) {
    f.fns.request(f.context, f.cache, "rgba16float", true, {});
    f.release(f.plain | f.emit);
    await settle();
  }
  f.fns.request(f.context, f.cache, "rgba16float", true);
  f.release(f.active | f.emit);
  await settle();
  const independentlyReady = f.frame();
  f.fns.request(f.context, f.cache, "rgba16float", true, {
    ...featuresModule.cloudMarchActiveFeatures(f.cache),
    deep: false,
  });
  f.release(f.base | f.emit);
  await settle();
  const matchingReady = f.frame();
  f.release(f.active);
  await settle();
  const upgraded = f.frame();
  return { ...f, independentlyReady, matchingReady, upgraded };
}
function assertSelectedEmissionFamily(row, emit) {
  assert(
    Number.isInteger(row.ordinary),
    "ordinary pipeline id must be an integer",
  );
  assert(
    Number.isInteger(row.visible),
    "visible pipeline id must be an integer",
  );
  assert(
    Number.isInteger(row.selected),
    "selected feature mask must be an integer",
  );
  assert.equal(row.pipelineSets, 1);
  assert.equal(row.draws, 1);
  assert.deepEqual(row.drawCalls, [3], "the visible pass must issue draw(3)");
  assert.equal(
    row.visible & ~emit,
    row.selected,
    "visible march must use selected ordinary feature family",
  );
  assert.equal(row.ordinary, row.selected);
  assert.equal(row.retainedStillRequested, true);
  assert.equal(
    row.maskModule,
    row.selectedModule,
    "mask module follows ordinary selection",
  );
  assert.equal(
    row.shadowModule,
    row.selectedModule,
    "shadow module follows ordinary selection",
  );
  assert.equal(
    row.requestedStillActive,
    true,
    "requested features must not be dropped",
  );
}
for (const bake of [true, false])
  test(
    "selected emission family remains coherent while independent async variants settle (baked=" +
      bake +
      ")",
    async () => {
      const trace = await selectedEmissionTrace(bake, undefined, bake);
      assert.equal(trace.independentlyReady.selected, trace.base);
      assertSelectedEmissionFamily(trace.independentlyReady, trace.emit);
      assertSelectedEmissionFamily(trace.matchingReady, trace.emit);
      assert.equal(
        trace.matchingReady.emitted,
        true,
        "matching fallback emission must become usable",
      );
      assert.equal(trace.matchingReady.targets, 2);
      assertSelectedEmissionFamily(trace.upgraded, trace.emit);
      assert.equal(
        trace.upgraded.selected,
        trace.active,
        "ready requested family must upgrade",
      );
      assert.equal(trace.upgraded.visible, trace.active | trace.emit);
    },
  );
test("selected emission healthy companions preserve preview, full resolution and primary reuse", async () => {
  const preview = await selectedEmissionFixture({
    preview: true,
    progressive: true,
  });
  const p = preview.frame();
  assert(p.selected & ShaderDefineHi.CLOUD_LIGHTING_PREVIEW);
  assertSelectedEmissionFamily(p, preview.emit);
  assert.equal(p.halfEmit, null);
  assert.equal(p.emitted, false);
  assert.equal(p.targets, 1);
  const full = await selectedEmissionFixture();
  const r = full.frame(false);
  assert.equal(r.visible, null);
  assert.equal(r.halfPipeline, null);
  assert.equal(r.halfEmit, null);
  assert.equal(r.fullPipeline, r.selected);
  assert.equal(r.maskModule, r.selectedModule);
  assert.equal(
    full.log.modules.some((hi) => (hi & full.emit) !== 0),
    false,
  );
  const reuse = await selectedEmissionFixture({ bake: false });
  const ordinary = reuse.frame();
  const primary = reuse.fns.frame.primary(
    reuse.context,
    reuse.cache,
    true,
    true,
  );
  assert(primary);
  assert.equal(primary.id & ~(reuse.primary | reuse.emit), ordinary.selected);
  assert.equal(reuse.cache.selectedMarchDefinesHi, ordinary.selected);
  assert.equal(reuse.log.sync.at(-1).entry, "fragmentCloudPrimaryMain");
  assert.deepEqual(Array.from(reuse.log.sync.at(-1).targets), [
    "rgba16float",
    "r8unorm",
    "rg32float",
  ]);
  const skipped = reuse.frame(true, true);
  assert.equal(
    skipped.draws,
    0,
    "primary reuse must skip the ordinary half march",
  );
});

test("selected emission callsite and selector override inerts lose the same family oracle", async () => {
  const healthy = await selectedEmissionTrace(true, undefined, true);
  assertSelectedEmissionFamily(healthy.independentlyReady, healthy.emit);
  const renderer = worktreeRenderer();
  const oldCall =
    "    cache.halfEmitPipeline =\n      halfResActive &&\n      marchPipeline &&\n      !cache.usingStartupPreview &&\n      cache.reconstructionEnabled\n        ? requestCloudMarchPipeline(context, cache, CLOUD_HALF_FORMAT, true)\n        : null;";
  const callsite = replaceOnce(
    renderer,
    selectedEmissionStatement(renderer, "    cache.halfEmitPipeline ="),
    oldCall,
  );
  const override = replaceOnce(
    renderer,
    "features.selectedDefinesHi ??",
    "(false ? features.selectedDefinesHi : undefined) ??",
  );
  for (const source of [callsite, override]) {
    const trace = await selectedEmissionTrace(true, source, true);
    assert.throws(
      () => assertSelectedEmissionFamily(trace.independentlyReady, trace.emit),
      /visible march must use selected ordinary feature family/,
    );
    assert.equal(
      trace.upgraded.ordinary,
      trace.active,
      "ordinary requested-family upgrade stays healthy under the inert",
    );
    assert.equal(trace.upgraded.maskModule, trace.upgraded.selectedModule);
    assert.equal(trace.upgraded.shadowModule, trace.upgraded.selectedModule);
  }
});

// The frame's emitting half march requests, executed through the real
// preparation slice. While the ladder draws a simpler variant, the bound
// emitting pipeline is the selected recipe's and the active recipe's emitting
// pipeline is requested beside it, never bound.
async function warmEmissionTrace(renderer, readyActive = false) {
  const f = await selectedEmissionFixture({
    bake: true,
    renderer,
    readyActive,
  });
  const config = { cloudProgressiveStartup: false };
  const emitting = () =>
    f.log.async.filter((d) => (d.definesHi & f.emit) !== 0);
  const requestedBefore = f.log.async.length + f.log.sync.length;
  f.fns.frame.prepare(f.context, f.cache, true, config);
  const firstFrame = {
    selected: f.cache.selectedMarchDefinesHi,
    emitting: emitting().map((d) => d.definesHi),
    emittingTargets: emitting().map((d) => d.targets.length),
    bound: f.cache.halfEmitPipeline?.id ?? null,
    requests: f.log.async.length + f.log.sync.length - requestedBefore,
  };
  // Settle every emitting compile the first frame started.
  for (const hi of firstFrame.emitting) {
    f.release(hi);
  }
  await settle();
  const afterSettle = f.log.async.length + f.log.sync.length;
  const lookupsBefore = f.log.modules.length;
  f.fns.frame.prepare(f.context, f.cache, true, config);
  const secondFrame = {
    selected: f.cache.selectedMarchDefinesHi,
    bound: f.cache.halfEmitPipeline?.id ?? null,
    requests: f.log.async.length + f.log.sync.length - afterSettle,
    moduleLookups: f.log.modules.length - lookupsBefore,
  };
  return { ...f, firstFrame, secondFrame };
}
// The emitting pipeline is requested with the selected recipe.
function assertBoundEmissionRecipe(trace) {
  assert.ok(
    trace.firstFrame.emitting.includes(trace.firstFrame.selected | trace.emit),
    "the emitting pipeline is requested with the selected recipe",
  );
}
// The emitting variant of the active recipe is requested in the same frame.
function assertWarmEmissionRequested(trace) {
  assert.notEqual(
    trace.active,
    trace.firstFrame.selected,
    "ladder is climbing",
  );
  assert.ok(
    trace.firstFrame.emitting.includes(trace.active | trace.emit),
    "the active recipe's emitting pipeline is requested while a simpler one draws",
  );
  assert.deepEqual(
    trace.firstFrame.emittingTargets,
    trace.firstFrame.emitting.map(() => 2),
    "both requests are emitting pipelines with the emitted-depth target",
  );
}
// Both emitting pipelines are ready and the frame binds the selected recipe's.
function assertWarmEmissionNotBound(trace) {
  assert.equal(
    trace.secondFrame.bound,
    trace.secondFrame.selected | trace.emit,
    "the warm request's pipeline must never become cache.halfEmitPipeline",
  );
  assert.equal(
    trace.secondFrame.selected,
    trace.firstFrame.selected,
    "the warm request moves no selected-variant state",
  );
}
const WARM_ORACLES = [
  [assertBoundEmissionRecipe, /requested with the selected recipe/],
  [assertWarmEmissionRequested, /requested while a simpler one draws/],
  [assertWarmEmissionNotBound, /must never become cache.halfEmitPipeline/],
];
function warmOracleVerdicts(trace) {
  return WARM_ORACLES.map(([oracle, message]) => {
    try {
      oracle(trace);
      return "green";
    } catch (error) {
      assert.match(error.message, message);
      return "red";
    }
  });
}

test("warm emission (a): while a simpler variant draws the emitting pipeline is requested with the selected recipe", async () => {
  const trace = await warmEmissionTrace();
  assert.equal(trace.firstFrame.selected, trace.base);
  assert.notEqual(trace.firstFrame.selected, trace.active);
  assertBoundEmissionRecipe(trace);
});

test("warm emission (b): while a simpler variant draws the active recipe's emitting pipeline is requested as well", async () => {
  const trace = await warmEmissionTrace();
  assertWarmEmissionRequested(trace);
  assert.deepEqual(
    [...trace.firstFrame.emitting].sort(),
    [trace.base | trace.emit, trace.active | trace.emit].sort(),
    "exactly the selected and the active emitting variants compile",
  );
  assert.equal(
    trace.secondFrame.requests,
    0,
    "once both emitting variants are in the pipeline map a frame compiles nothing",
  );
});

test("warm emission (c): the warm request's ready pipeline is not what cache.halfEmitPipeline holds", async () => {
  const trace = await warmEmissionTrace();
  assertWarmEmissionNotBound(trace);
  assert.equal(trace.secondFrame.bound, trace.base | trace.emit);
});

test("warm emission: once the ladder reaches the active recipe the warm request is a pipeline map hit", async () => {
  const trace = await warmEmissionTrace(undefined, true);
  assert.equal(trace.firstFrame.selected, trace.active);
  assert.deepEqual(
    trace.firstFrame.emitting,
    [trace.active | trace.emit],
    "one emitting compile, not two",
  );
  assert.equal(trace.secondFrame.bound, trace.active | trace.emit);
  assert.equal(trace.secondFrame.requests, 0);
  // A steady frame makes three march requests, all pipeline map hits: the
  // ladder's, the bound emitting one and the warm one. Without the warm
  // request it makes two.
  assert.equal(trace.secondFrame.moduleLookups, 3);
  const without = await warmEmissionTrace(
    replaceOnce(
      worktreeRenderer(),
      "      requestCloudMarchPipeline(context, cache, CLOUD_HALF_FORMAT, true);\n",
      "",
    ),
    true,
  );
  assert.equal(without.secondFrame.moduleLookups, 2);
});

test("warm emission mutants: each is red on its own case", async () => {
  const renderer = worktreeRenderer();
  const warm =
    "      requestCloudMarchPipeline(context, cache, CLOUD_HALF_FORMAT, true);\n";
  const bound =
    "? requestCloudMarchPipeline(context, cache, CLOUD_HALF_FORMAT, true, {\n          selectedDefinesHi: cache.selectedMarchDefinesHi,\n        })";
  const mutants = [
    {
      name: "the warm request removed",
      source: replaceOnce(renderer, warm, ""),
      verdicts: ["green", "red", "green"],
    },
    {
      name: "the warm request's result assigned to cache.halfEmitPipeline",
      source: replaceOnce(
        renderer,
        warm,
        "      cache.halfEmitPipeline = requestCloudMarchPipeline(context, cache, CLOUD_HALF_FORMAT, true);\n",
      ),
      verdicts: ["green", "green", "red"],
    },
    {
      name: "the bound request made with the active recipe",
      source: replaceOnce(
        renderer,
        bound,
        "? requestCloudMarchPipeline(context, cache, CLOUD_HALF_FORMAT, true)",
      ),
      verdicts: ["red", "green", "red"],
    },
  ];
  assert.deepEqual(warmOracleVerdicts(await warmEmissionTrace()), [
    "green",
    "green",
    "green",
  ]);
  for (const { name, source, verdicts } of mutants) {
    assert.deepEqual(
      warmOracleVerdicts(await warmEmissionTrace(source)),
      verdicts,
      name,
    );
  }
});

test("selected emission mask and shadow invalidation made unreachable loses the module oracle", async () => {
  const healthy = await selectedEmissionTrace(true, undefined, true);
  assertSelectedEmissionFamily(healthy.upgraded, healthy.emit);
  const renderer = worktreeRenderer();
  const kept = "    cache.maskShaderModule = module;\n";
  const nulls =
    "    cache.maskPipeline = null;\n    cache.shadowPipeline = null;\n";
  const mutants = [
    {
      name: "both invalidations unreachable",
      source: replaceOnce(renderer, kept + nulls, kept + "    return ready;\n"),
      message: /mask module follows ordinary selection/,
    },
    {
      name: "mask invalidation dropped",
      source: replaceOnce(
        renderer,
        kept + nulls,
        kept + "    cache.shadowPipeline = null;\n",
      ),
      message: /mask module follows ordinary selection/,
    },
    {
      name: "shadow invalidation dropped",
      source: replaceOnce(
        renderer,
        kept + nulls,
        kept + "    cache.maskPipeline = null;\n",
      ),
      message: /shadow module follows ordinary selection/,
    },
  ];
  for (const { name, source, message } of mutants) {
    const trace = await selectedEmissionTrace(true, source, true);
    assert.throws(
      () => assertSelectedEmissionFamily(trace.upgraded, trace.emit),
      message,
      name,
    );
    assert.equal(
      trace.upgraded.ordinary,
      trace.active,
      name + ": the ordinary upgrade stays healthy",
    );
    assert.equal(
      trace.upgraded.visible,
      trace.active | trace.emit,
      name + ": the emitting variant still follows the selection",
    );
  }
});
