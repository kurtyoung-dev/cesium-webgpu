// water-ocean-tier-transition.spec.mjs: behaviour of the WebGPU globe's ocean tiers and the classic-to-enhanced fade.
// @purpose Drives the real GlobeOceanTierTransition, the real selectPipeline and the real tile-uniform packer under fake devices, so the fade, the stale-resolution guard, the Tier 2 warm gate, the bootstrap fallback and the tide CPU gate are checked as behaviour, with an inertness mutant behind each.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/water-ocean-tier-transition.spec.mjs
//
// WHY THIS EXISTS. water-async-pipeline-transition.spec.mjs matches the SOURCE TEXT of these paths and re-implements
// the smoothstep it claims to check, so it stays green with the fade unreachable. This spec executes the code.
//
// WHAT IS REAL AND WHAT IS FAKE. Real: WebGPUGlobeSurfaceOceanTiers.ts (the state machine), WebGPUGlobeSurfaceRenderer.ts
// (the tier flips and the per-tile tick), WebGPUGlobeSurfacePipelines.ts (selectPipeline, the cached-fallback lookup,
// the Tier 2 warm), the shader-module cache, the preprocessor and the central pipeline cache. Fake: the GPUDevice (it
// records every module and pipeline it is asked for, and can hold pipeline promises until the test releases or rejects
// them), the clock, and `setTimeout` for the one test that counts timers. Every other engine import is a Proxy stub.
//
// MUTANTS. Each `mutant` call re-bundles the same graph with ONE clause made unreachable (`if (false && ...)` or the
// equivalent) and requires the scenario that pins it to fail. The mutation is applied to an in-memory copy; no source
// file is written.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle } from "./lib/engine-stub-bundler.mjs";
import { readEngineShader } from "./lib/engine-shader-source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const engine = path.join(root, "packages/engine/Source");
const webgpu = path.join(engine, "Renderer/WebGPU");

const REAL_WGSL = readEngineShader("Shaders/WebGPU/Globe/GlobeTerrain.wgsl", {
  eol: "native",
});

// ───────────────────────────── graph helpers ───────────────────────────────

/**
 * An override that makes `anchor` (which must occur exactly once) read as
 * `replacement`. A mutation that matched nothing, or twice, would test nothing.
 */
function swap(basename, anchor, replacement, label) {
  return {
    basename,
    label,
    mutate: (source) => {
      const count = source.split(anchor).length - 1;
      assert.equal(
        count,
        1,
        `mutant ${label}: the anchor must occur exactly once in ${basename}, found ${count}: ${anchor.slice(0, 70)}`,
      );
      return source.replace(anchor, () => replacement);
    },
  };
}

const RENDERER_REAL = [
  "WebGPUGlobeSurfaceRenderer.ts",
  "WebGPUGlobeSurfacePipelines.ts",
  "WebGPUGlobeSurfacePipelineKey.ts",
  "WebGPUGlobeSurfaceShaders.ts",
  "WebGPUGlobeSurfaceTypes.ts",
  "WebGPUGlobeSurfaceOceanTiers.ts",
  "WebGPUShaderModuleCache.ts",
  "WebGPUShaderPreprocessor.ts",
  "WebGPUShaderDefines.ts",
  "WebGPURenderPipelineCache.ts",
  "WebGPUDeviceInvalidationBus.ts",
  "AsyncResourceMonitor.ts",
  "defined.js",
];

const RENDERER_ENTRY = [
  'export { WebGPUGlobeSurfaceRenderer } from "./WebGPUGlobeSurfaceRenderer.js";',
  'export { selectPipeline } from "./WebGPUGlobeSurfacePipelines.js";',
  'export { WebGPURenderPipelineCache } from "./WebGPURenderPipelineCache.js";',
  'export { ShaderDefineHi } from "./WebGPUShaderDefines.js";',
  'export { oceanDefinesHi, resolveWaterProviderParity } from "./WebGPUGlobeSurfaceShaders.js";',
  "export {",
  "  GlobeOceanTierTransition,",
  "  GlobeUnderwaterWarmPlan,",
  "  resolveUnderwaterTier,",
  "  stashResolvedPipelinesAsFallback,",
  "  OCEAN_TRANSITION_DURATION_MS,",
  "  OCEAN_TRANSITION_PENDING_TIMEOUT_MS,",
  '} from "./WebGPUGlobeSurfaceOceanTiers.js";',
].join("\n");

function importRenderer(overrides = []) {
  return bundle({
    path: path.join(webgpu, "__ocean-tier-spec.ts"),
    source: RENDERER_ENTRY,
    real: RENDERER_REAL,
    preseed: [
      path.join(webgpu, "WebGPUGlobeSurfaceRenderer.ts"),
      path.join(webgpu, "WebGPUGlobeSurfacePipelines.ts"),
    ],
    overrides,
  });
}

const TILE_UB_REAL = [
  "WebGPUGlobeSurfaceTileUB.ts",
  "WebGPUGlobeSurfaceTypes.ts",
  "WebGPUGlobeTunables.ts",
  "WebGPUVectorTileResources.ts",
  "WebGPUGlobeLightingFade.ts",
  "GlobeNightImagery.js",
  "GlobeOceanWaveClock.js",
  "SceneMode.js",
];

// TideModel is replaced so the spec can COUNT the work; everything else in
// Core (Ellipsoid, Cartesian3, ...) is real.
function importTileUb(overrides = []) {
  return bundle({
    path: path.join(webgpu, "__ocean-tier-tile-ub-spec.ts"),
    source: [
      'export { createTileUniformBuffer } from "./WebGPUGlobeSurfaceTileUB.js";',
      'export { OCEAN_TIDE_HEIGHT_OFFSET, TILE_UNIFORM_FLOATS } from "./WebGPUGlobeSurfaceTypes.js";',
      'export { default as Ellipsoid } from "../../Core/Ellipsoid.js";',
    ].join("\n"),
    real: TILE_UB_REAL,
    realDir: path.join(engine, "Core"),
    preseed: [path.join(webgpu, "WebGPUGlobeSurfaceTileUB.ts")],
    stubSources: {
      "../../Core/TideModel.js":
        "export default { equilibriumHeight() { globalThis.__tideModelCalls = (globalThis.__tideModelCalls ?? 0) + 1; return 0.5; } };",
      "./WebGPUGlobeSurfaceCameraUB.js":
        "export const writeUniformSlice = (device, frameState, data, size) => { globalThis.__tileUbData = data.slice(); return { buffer: {}, offset: 0, size }; };",
      "./WebGPUGlobeFragmentDebug.js":
        "export const getActiveDebugSentinel = () => null;",
    },
    overrides,
  });
}

// ───────────────────────────── fakes ───────────────────────────────────────

/**
 * A device that records every shader module and pipeline it is asked for.
 * With `hold` set, `createRenderPipelineAsync` returns promises the test
 * settles through `log.held`.
 */
function makeFakeDevice({ hold = false } = {}) {
  const log = { shaderModules: [], sync: [], async: [], held: [] };
  const device = {
    limits: { maxSampledTexturesPerShaderStage: 32 },
    features: new Set(),
    queue: { writeBuffer() {}, writeTexture() {}, submit() {} },
    createShaderModule(descriptor) {
      const module = { __kind: "shader", label: descriptor.label };
      log.shaderModules.push(module);
      return module;
    },
    createRenderPipeline(descriptor) {
      const pipeline = { __kind: "pipeline", label: descriptor.label };
      log.sync.push(pipeline);
      return pipeline;
    },
    createRenderPipelineAsync(descriptor) {
      const pipeline = { __kind: "pipeline", label: descriptor.label };
      log.async.push(pipeline);
      if (!hold) {
        return Promise.resolve(pipeline);
      }
      return new Promise((resolve, reject) => {
        log.held.push({
          label: descriptor.label,
          release: () => resolve(pipeline),
          reject: (error) => reject(error),
        });
      });
    },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createSampler: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createBuffer: () => ({ destroy() {} }),
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
  };
  return { device, log };
}

/**
 * A globe renderer wired the way a frame finds it: initialised against the
 * fake device, with a central pipeline cache and a controllable clock.
 */
function boot(ns, { hold = false, wgsl } = {}) {
  const { device, log } = makeFakeDevice({ hold });
  const renderer = new ns.WebGPUGlobeSurfaceRenderer();
  renderer.initialize(
    device,
    wgsl ??
      "@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1.0); }\n",
    "bgra8unorm",
  );
  renderer._centralPipelineCache = new ns.WebGPURenderPipelineCache(device);
  renderer._logDepthEnabled = true;
  const clock = { t: 10000 };
  renderer._oceanTier = new ns.GlobeOceanTierTransition(() => clock.t);
  return { renderer, device, log, clock };
}

function provider(enhanced) {
  return { enableEnhancedOcean: enhanced };
}

/** One `_tickOceanTier` call for one tile, as `createTileCommands` makes it. */
function tick(
  renderer,
  tileProvider,
  { frameNumber, eyeHeight = 20000, underground = false, afterRender = [] },
) {
  renderer._tickOceanTier(
    tileProvider,
    { frameNumber, afterRender, cameraUnderground: underground },
    { eyeHeight },
  );
  return afterRender;
}

/** The first colour pass of a plain uncompressed tile, as a tile requests it. */
function select(ns, renderer, { clipDistances = false, normals = true } = {}) {
  return ns.selectPipeline(
    renderer,
    false,
    normals,
    false,
    false,
    normals ? 36 : 32,
    clipDistances,
    false,
    false,
  );
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Replaces `setTimeout` for a synchronous window and records what was scheduled. */
function recordTimers() {
  const original = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  return {
    scheduled,
    restore: () => {
      globalThis.setTimeout = original;
    },
  };
}

function tier2Modules(ns, log) {
  return log.shaderModules.filter((m) => {
    const match = /hi=0x([0-9a-f]+)/.exec(m.label);
    return (
      match &&
      (parseInt(match[1], 16) & ns.ShaderDefineHi.UNDERWATER_OPTICS) !== 0
    );
  });
}

async function silenced(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

// ───────────────────────────── scenarios ───────────────────────────────────
// Each scenario asserts one family of behaviours against a bundled graph, and
// is run twice: against the real graph (must pass) and against each mutant of
// the clause it pins (must fail).

/** C3: pending is 1.0, then a monotonic smoothstep to 0 within 600 ms. */
function scenarioFade(ns) {
  const clock = { t: 5000 };
  const tr = new ns.GlobeOceanTierTransition(() => clock.t);
  const classic = {};
  tr.stamp(classic, false);
  tr.noteResolved(classic);
  assert.equal(tr.deficit, 0, "classic resolutions alone leave no fade");
  assert.equal(tr.isActive, false);

  tr.onEnhancedChanged(true, true);
  assert.equal(
    tr.deficit,
    1,
    "the deficit holds at 1.0 while enhanced is pending",
  );
  tr.noteResolved(classic);
  assert.equal(
    tr.deficit,
    1,
    "a resolution from a classic entry must not start the fade",
  );

  const enhanced = {};
  tr.stamp(enhanced, true);
  tr.noteResolved(enhanced);
  let previous = Number.POSITIVE_INFINITY;
  let atMidpoint = null;
  for (let ms = 0; ms <= 600; ms += 10) {
    clock.t = 5000 + ms;
    tr.beginFrame(ms);
    const deficit = tr.deficit;
    assert.ok(deficit <= previous, `deficit must not rise at ${ms} ms`);
    previous = deficit;
    if (ms === 300) {
      atMidpoint = deficit;
    }
    if (ms === 0) {
      assert.equal(deficit, 1, "the fade starts at the full deficit");
    }
    if (ms === 590) {
      assert.ok(deficit > 0, "the fade is still running at 590 ms");
    }
  }
  assert.equal(atMidpoint, 0.5, "the smoothstep is 0.5 at the midpoint");
  assert.equal(previous, 0, "the deficit is 0 at 600 ms");
  assert.equal(tr.isActive, false, "a finished fade stops asking for frames");
}

/** H-01: a resolution from an entry the cache no longer holds is ignored. */
function scenarioStale(ns) {
  const clock = { t: 5000 };
  const tr = new ns.GlobeOceanTierTransition(() => clock.t);
  tr.onEnhancedChanged(true, true);
  const early = {};
  tr.stamp(early, true);
  // The user flips enhanced off and on again before `early` finishes compiling.
  tr.onEnhancedChanged(false, true);
  tr.onEnhancedChanged(true, true);
  tr.noteResolved(early);
  clock.t += 300;
  tr.beginFrame(1);
  assert.equal(
    tr.deficit,
    1,
    "a late resolution from before the flip neither starts the fade nor marks enhanced as resolved",
  );
  const current = {};
  tr.stamp(current, true);
  tr.noteResolved(current);
  clock.t += 300;
  tr.beginFrame(2);
  assert.equal(
    tr.deficit,
    0.5,
    "the current entry's resolution starts the fade",
  );
}

/** C4: a rejected compile abandons the fade and stops requesting frames. */
function scenarioFailure(ns) {
  const clock = { t: 5000 };
  const tr = new ns.GlobeOceanTierTransition(() => clock.t);
  tr.onEnhancedChanged(true, true);
  const entry = {};
  tr.stamp(entry, true);
  assert.equal(tr.deficit, 1);
  tr.noteFailed(entry);
  assert.equal(tr.deficit, 0, "a failed compile leaves no pinned deficit");
  assert.equal(tr.isActive, false);
  const afterRender = [];
  tr.requestFrame(afterRender);
  assert.equal(afterRender.length, 0, "an abandoned fade requests no frames");
  tr.noteFallbackUsed(true);
  assert.equal(
    tr.isActive,
    false,
    "a fallback tile does not re-arm an abandoned fade",
  );
  // A new flip is a new attempt.
  tr.onEnhancedChanged(false, true);
  tr.onEnhancedChanged(true, true);
  assert.equal(tr.deficit, 1, "a new flip starts a new attempt");
}

/** C4: a fade whose pipelines never land is abandoned within a bounded time. */
function scenarioTimeout(ns) {
  const clock = { t: 5000 };
  const tr = new ns.GlobeOceanTierTransition(() => clock.t);
  tr.onEnhancedChanged(true, true);
  clock.t += ns.OCEAN_TRANSITION_PENDING_TIMEOUT_MS - 1;
  tr.beginFrame(1);
  assert.equal(tr.deficit, 1, "still waiting just inside the timeout");
  clock.t += 1;
  tr.beginFrame(2);
  assert.equal(tr.deficit, 0, "abandoned at the timeout");
  assert.equal(tr.isActive, false);
}

/** C4: at most one afterRender callback per frame, however many tiles ask. */
function scenarioFrameRequest(ns) {
  const clock = { t: 5000 };
  const tr = new ns.GlobeOceanTierTransition(() => clock.t);
  tr.onEnhancedChanged(true, true);
  for (let frame = 0; frame < 60; frame++) {
    const afterRender = [];
    for (let tile = 0; tile < 400; tile++) {
      tr.requestFrame(afterRender);
    }
    assert.equal(
      afterRender.length,
      1,
      `frame ${frame}: one callback for 400 tiles`,
    );
    assert.equal(afterRender[0](), true, "the callback requests another frame");
  }
}

/** H-14: the deficit the packer reads is a pure function of the frame's clock sample. */
function scenarioClockSampling(ns) {
  const clock = { t: 5000 };
  const tr = new ns.GlobeOceanTierTransition(() => clock.t);
  tr.onEnhancedChanged(true, true);
  const entry = {};
  tr.stamp(entry, true);
  tr.noteResolved(entry);
  clock.t += 200;
  tr.beginFrame(7);
  const first = tr.deficit;
  clock.t += 300;
  tr.beginFrame(7);
  assert.equal(
    tr.deficit,
    first,
    "a second tile in the same frame does not resample the clock",
  );
  assert.equal(tr.deficit, first, "reading the deficit twice gives one value");
  tr.beginFrame(8);
  assert.ok(tr.deficit < first, "the next frame samples again");
}

/** C7 / hysteresis: Tier 2 enters under 500 m, leaves over 1500 m, warms under 5000 m. */
function scenarioTierDecision(ns) {
  const r = ns.resolveUnderwaterTier;
  assert.deepEqual(r(true, false, 499, false), {
    wanted: true,
    warmEligible: true,
  });
  assert.deepEqual(r(true, false, 501, false), {
    wanted: false,
    warmEligible: true,
  });
  assert.deepEqual(r(true, false, 1499, true), {
    wanted: true,
    warmEligible: true,
  });
  assert.deepEqual(r(true, false, 1501, true), {
    wanted: false,
    warmEligible: true,
  });
  assert.deepEqual(r(true, false, 4999, false).warmEligible, true);
  assert.deepEqual(r(true, false, 5001, false).warmEligible, false);
  assert.deepEqual(r(true, false, 20000, false), {
    wanted: false,
    warmEligible: false,
  });
  assert.deepEqual(r(false, true, 100, true), {
    wanted: false,
    warmEligible: false,
  });
  assert.deepEqual(r(true, true, 90000, false), {
    wanted: true,
    warmEligible: true,
  });
  assert.deepEqual(r(true, false, undefined, true), {
    wanted: true,
    warmEligible: false,
  });
  assert.deepEqual(r(true, false, undefined, false), {
    wanted: false,
    warmEligible: false,
  });
}

/** C7: Tier 2 candidates are held until the eye is near, then released once. */
function scenarioWarmPlan(ns) {
  const plan = new ns.GlobeUnderwaterWarmPlan();
  const candidate = (stride) => ({
    hasNormals: true,
    hasWebMercatorT: false,
    strideBytes: stride,
    hasGeodeticSurfaceNormals: false,
    disableCulling: false,
  });
  assert.equal(
    plan.noteCandidate("a", candidate(36)),
    false,
    "held while the eye is far",
  );
  assert.equal(plan.noteCandidate("b", candidate(32)), false);
  assert.equal(
    plan.noteCandidate("a", candidate(36)),
    false,
    "a repeated key is held once",
  );
  const released = plan.arm();
  assert.equal(released.length, 2);
  assert.equal(plan.eligible, true);
  assert.equal(plan.arm().length, 0, "released once");
  assert.equal(
    plan.noteCandidate("c", candidate(36)),
    true,
    "warmed at once when near",
  );
  plan.reset();
  assert.equal(plan.eligible, false);
  assert.equal(
    plan.noteCandidate("d", candidate(36)),
    false,
    "held again after a reset",
  );
}

/** Compound flips: the second wipe of one tick keeps the first wipe's fallbacks. */
function scenarioStash(ns) {
  const fallback = new Map([["stale", { id: "stale" }]]);
  const pipelines = new Map([
    ["k1", { descriptor: {}, pipeline: { id: "p1" }, pending: false }],
    [
      "k2",
      {
        descriptor: {},
        pipeline: null,
        fallbackPipeline: { id: "f2" },
        pending: true,
      },
    ],
    ["k3", { descriptor: {}, pipeline: null, pending: true }],
  ]);
  ns.stashResolvedPipelinesAsFallback(pipelines, fallback);
  assert.deepEqual(
    [...fallback.keys()],
    ["k1", "k2"],
    "resolved and fallback pipelines are kept, a bare pending entry is not",
  );
  assert.equal(fallback.get("k2").id, "f2");
  ns.stashResolvedPipelinesAsFallback(new Map(), fallback);
  assert.deepEqual(
    [...fallback.keys()],
    ["k1", "k2"],
    "an empty cache (the second flip of one tick) keeps the first flip's fallbacks",
  );
}

/** C6: an uncached key under enhanced ocean is skipped, never compiled on the render path. */
async function scenarioNoSyncCreation(ns) {
  const { renderer, log } = boot(ns);
  tick(renderer, provider(true), { frameNumber: 1 });
  const first = select(ns, renderer);
  assert.equal(first, null, "the tile is skipped while its pipeline compiles");
  assert.equal(
    log.sync.length,
    0,
    "no synchronous createRenderPipeline on the render path",
  );
  await flush();
  const labels = log.async.map((p) => p.label);
  assert.equal(
    new Set(labels).size,
    labels.length,
    `each descriptor is built once: ${labels.join(" | ")}`,
  );
  assert.equal(log.sync.length, 0);
  const served = select(ns, renderer);
  assert.ok(served, "the next frame is served from the cache");
}

/** C6 with a cached Tier-0: the classic pipeline is the fallback, still with no creation. */
async function scenarioCachedFallback(ns) {
  const { renderer, log, clock } = boot(ns);
  void clock;
  tick(renderer, provider(false), { frameNumber: 1 });
  assert.equal(select(ns, renderer), null);
  await flush();
  const classic = select(ns, renderer);
  assert.ok(classic, "the classic pipeline resolves");
  const created = log.async.length;
  // Enhanced is turned on at run time; its pipelines are not cached yet.
  tick(renderer, provider(true), { frameNumber: 2 });
  const during = select(ns, renderer);
  assert.equal(
    during,
    classic,
    "tiles keep the classic pipeline while enhanced compiles",
  );
  assert.equal(
    log.sync.length,
    0,
    "and nothing is created synchronously to get there",
  );
  assert.ok(
    log.async.length > created,
    "the enhanced pipeline is requested asynchronously",
  );
}

/** C3 end to end: classic resolved first, then enhanced turned on at run time. */
async function scenarioRuntimeFlip(ns) {
  const { renderer, clock } = boot(ns);
  const classicProvider = provider(false);
  tick(renderer, classicProvider, { frameNumber: 1 });
  select(ns, renderer);
  await flush();
  assert.ok(select(ns, renderer), "classic frames resolved before the flip");
  assert.equal(renderer._getOceanTransitionDeficit(), 0);

  const enhancedProvider = provider(true);
  tick(renderer, enhancedProvider, { frameNumber: 2 });
  assert.equal(
    renderer._getOceanTransitionDeficit(),
    1,
    "the deficit is 1.0 straight after the flip, while enhanced is pending",
  );
  assert.ok(
    select(ns, renderer),
    "tiles keep drawing with the classic pipeline while enhanced compiles",
  );
  assert.equal(renderer._getOceanTransitionDeficit(), 1);
  await flush();
  select(ns, renderer);
  clock.t += 100;
  tick(renderer, enhancedProvider, { frameNumber: 3 });
  const early = renderer._getOceanTransitionDeficit();
  assert.ok(early > 0 && early <= 1, `the fade is running: ${early}`);
  let previous = early;
  for (let frame = 4; frame < 80; frame++) {
    clock.t += 10;
    tick(renderer, enhancedProvider, { frameNumber: frame });
    const deficit = renderer._getOceanTransitionDeficit();
    assert.ok(deficit <= previous, "the deficit falls monotonically");
    previous = deficit;
  }
  clock.t += 600;
  tick(renderer, enhancedProvider, { frameNumber: 100 });
  assert.equal(
    renderer._getOceanTransitionDeficit(),
    0,
    "and is 0 after the window",
  );
}

/** H-01 at the renderer: an enhanced pipeline built before an off/on flip resolves late. */
async function scenarioRuntimeStale(ns) {
  const { renderer, log, clock } = boot(ns, { hold: true });
  tick(renderer, provider(false), { frameNumber: 1 });
  select(ns, renderer);
  log.held.splice(0).forEach((h) => h.release());
  await flush();
  assert.ok(select(ns, renderer), "classic resolved");
  tick(renderer, provider(true), { frameNumber: 2 });
  select(ns, renderer);
  const earlyEnhanced = log.held.splice(0);
  assert.ok(earlyEnhanced.length > 0, "enhanced compiles are held");
  tick(renderer, provider(false), { frameNumber: 3 });
  tick(renderer, provider(true), { frameNumber: 4 });
  assert.equal(renderer._getOceanTransitionDeficit(), 1);
  earlyEnhanced.forEach((h) => h.release());
  await flush();
  clock.t += 300;
  tick(renderer, provider(true), { frameNumber: 5 });
  assert.equal(
    renderer._getOceanTransitionDeficit(),
    1,
    "a late resolution from an entry the flip dropped does not start the fade",
  );
  select(ns, renderer);
  log.held.splice(0).forEach((h) => h.release());
  await flush();
  select(ns, renderer);
  clock.t += 300;
  tick(renderer, provider(true), { frameNumber: 6 });
  const deficit = renderer._getOceanTransitionDeficit();
  assert.ok(
    deficit > 0 && deficit < 1,
    `the current entry starts the fade: ${deficit}`,
  );
}

/** C4 at the renderer: 400 tiles x 60 frames push at most one callback a frame; a rejection ends it. */
async function scenarioRuntimeFrames(ns) {
  const { renderer, log, clock } = boot(ns, { hold: true });
  tick(renderer, provider(false), { frameNumber: 1 });
  select(ns, renderer);
  log.held.splice(0).forEach((h) => h.release());
  await flush();
  select(ns, renderer);

  const enhanced = provider(true);
  let worst = 0;
  for (let frame = 2; frame < 62; frame++) {
    const afterRender = [];
    for (let tile = 0; tile < 400; tile++) {
      tick(renderer, enhanced, { frameNumber: frame, afterRender });
    }
    worst = Math.max(worst, afterRender.length);
    select(ns, renderer);
  }
  assert.equal(worst, 1, "one afterRender callback per frame for 400 tiles");

  // Every held enhanced compile is rejected.
  const rejected = log.held.splice(0);
  assert.ok(rejected.length > 0, "enhanced compiles were requested");
  await silenced(async () => {
    rejected.forEach((h) => h.reject(new Error("compile failed")));
    await flush();
  });
  clock.t += 50;
  const after = [];
  tick(renderer, enhanced, { frameNumber: 70, afterRender: after });
  assert.equal(after.length, 0, "a rejected compile stops requesting frames");
  assert.equal(
    renderer._getOceanTransitionDeficit(),
    0,
    "and releases the deficit",
  );
}

/** C4 at the renderer: pipelines that never land are abandoned at the timeout. */
async function scenarioRuntimeTimeout(ns) {
  const { renderer, log, clock } = boot(ns, { hold: true });
  tick(renderer, provider(false), { frameNumber: 1 });
  select(ns, renderer);
  log.held.splice(0).forEach((h) => h.release());
  await flush();
  select(ns, renderer);
  tick(renderer, provider(true), { frameNumber: 2 });
  select(ns, renderer);
  assert.equal(renderer._getOceanTransitionDeficit(), 1);
  clock.t += ns.OCEAN_TRANSITION_PENDING_TIMEOUT_MS;
  const afterRender = [];
  tick(renderer, provider(true), { frameNumber: 3, afterRender });
  assert.equal(
    renderer._getOceanTransitionDeficit(),
    0,
    "abandoned at the timeout",
  );
  assert.equal(afterRender.length, 0, "and no longer holds a render loop open");
}

/** Compound flip: enhanced turning on with the eye already underwater keeps the classic fallback. */
async function scenarioCompoundFlip(ns) {
  const { renderer, log } = boot(ns, { wgsl: REAL_WGSL });
  tick(renderer, provider(false), { frameNumber: 1, eyeHeight: 100 });
  select(ns, renderer);
  select(ns, renderer, { clipDistances: true });
  await flush();
  const classic = select(ns, renderer);
  const classicClip = select(ns, renderer, { clipDistances: true });
  assert.ok(classic);
  assert.ok(classicClip, "the classic clip-distance variant resolves");
  tick(renderer, provider(true), { frameNumber: 2, eyeHeight: 100 });
  assert.equal(renderer._enhancedOceanEnabled, true);
  assert.equal(
    renderer._underwaterOpticsEnabled,
    true,
    "both flips happened in one tick",
  );
  assert.equal(
    select(ns, renderer),
    classic,
    "the classic pipeline still draws while Tier 2 compiles",
  );
  // A clip-distance variant has no central-cache lookup to fall back on: the
  // fallback cache is all it has.
  assert.equal(
    select(ns, renderer, { clipDistances: true }),
    classicClip,
    "the classic clip-distance pipeline still draws too",
  );
  assert.equal(log.sync.length, 0);
}

/** C7 + hysteresis + clip-distance skip, through selectPipeline and the renderer tick. */
async function scenarioTier2Warm(ns) {
  const { renderer, log } = boot(ns, { wgsl: REAL_WGSL });
  const enhanced = provider(true);
  const timers = recordTimers();
  try {
    for (let frame = 1; frame <= 10; frame++) {
      tick(renderer, enhanced, { frameNumber: frame, eyeHeight: 20000 });
      select(ns, renderer);
      select(ns, renderer, { normals: false });
    }
    // Since water round 5 (FND-4) a key's speculative warms, the Tier 2
    // candidate among them, wait until its own enhanced pipeline resolves.
    await flush();
    tick(renderer, enhanced, { frameNumber: 10, eyeHeight: 20000 });
    select(ns, renderer);
    select(ns, renderer, { normals: false });
    assert.equal(
      timers.scheduled.length,
      0,
      "a 20 km camera schedules no Tier 2 timer",
    );
    assert.equal(
      tier2Modules(ns, log).length,
      0,
      "and creates no UNDERWATER_OPTICS module",
    );
    assert.equal(renderer._underwaterWarmPlan.eligible, false);

    tick(renderer, enhanced, { frameNumber: 11, eyeHeight: 4000 });
    assert.equal(
      renderer._underwaterWarmPlan.eligible,
      true,
      "4 km arms the warm",
    );
    assert.equal(timers.scheduled.length, 2, "one timer per remembered key");
    assert.ok(
      timers.scheduled.every((t) => t.delay === 180),
      "the warm is deferred a beat",
    );
    assert.equal(
      tier2Modules(ns, log).length,
      0,
      "nothing compiled yet; the timers have not fired",
    );
    const before = timers.scheduled.length;
    select(ns, renderer, { clipDistances: true });
    assert.equal(
      timers.scheduled.length,
      before,
      "a clip-distance variant is never warmed for Tier 2",
    );
    timers.scheduled.splice(0).forEach((t) => t.callback());
    const tier2 = tier2Modules(ns, log);
    assert.ok(
      tier2.length > 0,
      "the Tier 2 modules are built once the timers fire",
    );
    assert.equal(
      new Set(tier2.map((m) => m.label)).size,
      tier2.length,
      "each Tier 2 module is built once",
    );

    tick(renderer, enhanced, { frameNumber: 12, eyeHeight: 400 });
    assert.equal(
      renderer._underwaterOpticsEnabled,
      true,
      "under 500 m selects Tier 2",
    );
    tick(renderer, enhanced, { frameNumber: 13, eyeHeight: 1400 });
    assert.equal(
      renderer._underwaterOpticsEnabled,
      true,
      "1400 m keeps Tier 2",
    );
    tick(renderer, enhanced, { frameNumber: 14, eyeHeight: 1600 });
    assert.equal(renderer._underwaterOpticsEnabled, false, "1600 m drops it");
    tick(renderer, enhanced, { frameNumber: 15, eyeHeight: 400 });
    assert.equal(renderer._underwaterOpticsEnabled, true);
    const counts = tier2Modules(ns, log).length;
    tick(renderer, enhanced, { frameNumber: 16, eyeHeight: 1600 });
    tick(renderer, enhanced, { frameNumber: 17, eyeHeight: 400 });
    assert.equal(
      tier2Modules(ns, log).length,
      counts,
      "re-entering creates no further module",
    );
  } finally {
    timers.restore();
  }
}

/** A4 / HO-05: the tide CPU work and float 493 follow enhanced ocean, the Earth ellipsoid and their own gates. */
function scenarioTideGate(ns) {
  const WGS84 = ns.Ellipsoid.WGS84;
  const mars = {
    radii: { x: 3396190, y: 3396190, z: 3376200 },
    cartographicToCartesian: () => ({ x: 1, y: 2, z: 3 }),
  };
  const earth = {
    radii: WGS84.radii,
    cartographicToCartesian: (c, r) => WGS84.cartographicToCartesian(c, r),
  };
  const host = {
    _tileUniformData: new Float32Array(ns.TILE_UNIFORM_FLOATS),
    _tileUniformU32View: new Uint32Array(ns.TILE_UNIFORM_FLOATS),
    _diagLastLayerCountLogMs: 0,
    _diagLastFogLogMs: 0,
    _diagFogMissingLogged: true,
  };
  const tile = {
    level: 3,
    x: 1,
    y: 1,
    rectangle: {
      west: 0,
      east: 0.1,
      south: 0,
      north: 0.1,
      width: 0.1,
      height: 0.1,
    },
  };
  const run = (overrides, ellipsoid = earth) => {
    let callbackCalls = 0;
    globalThis.__tideModelCalls = 0;
    const tileProvider = {
      hasWaterMask: true,
      showWaterEffect: true,
      oceanTideCallback: () => {
        callbackCalls++;
        return 0.5;
      },
      oceanMeanSeaLevelPressure: 1003.25,
      ...overrides,
    };
    ns.createTileUniformBuffer(
      host,
      {},
      { waterMaskTexture: {} },
      tileProvider,
      { mapProjection: { ellipsoid }, time: {}, mode: 3, camera: {}, fog: {} },
      tile,
      [],
      false,
    );
    return {
      float493: globalThis.__tileUbData[ns.OCEAN_TIDE_HEIGHT_OFFSET],
      tideWork: callbackCalls + globalThis.__tideModelCalls,
    };
  };
  const off = run({ enableEnhancedOcean: false });
  assert.equal(off.tideWork, 0, "no tide work with enhanced ocean off");
  assert.equal(off.float493, 0, "float 493 is 0 at defaults, surge included");
  const unset = run({});
  assert.equal(unset.tideWork, 0);
  assert.equal(unset.float493, 0);

  const on = run({ enableEnhancedOcean: true });
  assert.equal(
    on.tideWork,
    1,
    "the tide is evaluated once per tile with enhanced ocean on",
  );
  assert.ok(
    Math.abs(on.float493 - 0.6) < 1e-6,
    `tide 0.5 plus surge 0.1: ${on.float493}`,
  );

  const tideOff = run({ enableEnhancedOcean: true, oceanTideEnabled: false });
  assert.equal(
    tideOff.tideWork,
    0,
    "switching the tide off skips the tide work",
  );
  assert.ok(
    Math.abs(tideOff.float493 - 0.1) < 1e-6,
    `the surge keeps its own gate: ${tideOff.float493}`,
  );

  const onMars = run({ enableEnhancedOcean: true }, mars);
  assert.equal(
    onMars.tideWork,
    0,
    "the Earth tide is not evaluated on another ellipsoid",
  );
  assert.ok(Math.abs(onMars.float493 - 0.1) < 1e-6);

  const noPressure = run({
    enableEnhancedOcean: true,
    oceanMeanSeaLevelPressure: undefined,
  });
  assert.ok(
    Math.abs(noPressure.float493 - 0.5) < 1e-6,
    "no pressure, no surge",
  );
}

/**
 * FND-4 (water round 5): enhanced ocean on from the first frame, with no
 * classic pipeline cached. The E-T capture drew nothing (uniform black, five
 * enhanced pipelines pending at frame 158). Now the classic pipeline of the
 * same key is requested alongside and draws the tile once it lands; the
 * fade's timeout keeps it; the enhanced pipeline takes over when it lands.
 */
async function scenarioBootstrapFallback(ns) {
  const { renderer, log, clock } = boot(ns, { hold: true });
  const enhanced = provider(true);
  tick(renderer, enhanced, { frameNumber: 1 });
  assert.equal(select(ns, renderer), null, "nothing is cached on frame 1");
  assert.equal(log.sync.length, 0, "and nothing is created synchronously");
  const held = log.held.splice(0);
  const classic = held.filter((h) => !/enhOcean/.test(h.label));
  const tier1 = held.filter((h) => /enhOcean/.test(h.label));
  assert.equal(
    classic.length,
    1,
    `the classic pipeline of the key is requested alongside: ${held.map((h) => h.label).join(" | ")}`,
  );
  assert.equal(tier1.length, 1, "and the enhanced one");
  classic[0].release();
  await flush();
  tick(renderer, enhanced, { frameNumber: 2 });
  const drawn = select(ns, renderer);
  assert.ok(
    drawn,
    "the tile draws with the classic pipeline while enhanced compiles",
  );
  assert.doesNotMatch(drawn.label, /enhOcean/);
  assert.equal(
    renderer._getOceanTransitionDeficit(),
    1,
    "the classic look holds while enhanced is pending",
  );
  // The fade times out; the tile keeps drawing, never nothing.
  clock.t += ns.OCEAN_TRANSITION_PENDING_TIMEOUT_MS + 1;
  tick(renderer, enhanced, { frameNumber: 3 });
  assert.equal(
    select(ns, renderer),
    drawn,
    "past the timeout the fallback stays",
  );
  tier1[0].release();
  await flush();
  tick(renderer, enhanced, { frameNumber: 4 });
  const own = select(ns, renderer);
  assert.ok(
    own && /enhOcean/.test(own.label),
    "the enhanced pipeline takes over",
  );
}

/**
 * FND-4: under enhanced ocean the speculative warms (blend twin, quantized twin)
 * wait for the entry's own pipeline instead of competing with it. Water round 6
 * (N2): the classic fallback lands first and draws, and still no warm is asked
 * for until the enhanced pipeline itself has landed.
 */
async function scenarioDeferredSpeculativeWarm(ns) {
  const { renderer, log } = boot(ns, { hold: true });
  const enhanced = provider(true);
  tick(renderer, enhanced, { frameNumber: 1 });
  select(ns, renderer);
  const first = log.held.splice(0);
  assert.equal(
    first.length,
    2,
    `frame 1 asks for the enhanced pipeline and the classic one only: ${first.map((h) => h.label).join(" | ")}`,
  );
  const classic = first.filter((h) => !/enhOcean/.test(h.label));
  const own = first.filter((h) => /enhOcean/.test(h.label));
  assert.equal(classic.length, 1, "one classic fallback request");
  assert.equal(own.length, 1, "one enhanced request");
  classic[0].release();
  await flush();
  for (let frame = 2; frame <= 4; frame++) {
    tick(renderer, enhanced, { frameNumber: frame });
    const drawn = select(ns, renderer);
    assert.ok(
      drawn && !/enhOcean/.test(drawn.label),
      "the classic fallback draws while the enhanced pipeline compiles",
    );
  }
  assert.equal(
    log.held.length,
    0,
    `no speculative warm while only the fallback draws: ${log.held.map((h) => h.label).join(" | ")}`,
  );
  own[0].release();
  await flush();
  tick(renderer, enhanced, { frameNumber: 5 });
  const resolved = select(ns, renderer);
  assert.ok(
    resolved && /enhOcean/.test(resolved.label),
    "the entry resolved to its own pipeline",
  );
  const warmed = log.held.splice(0);
  assert.ok(
    warmed.length >= 2,
    `once it resolves the blend and quantized twins are warmed: ${warmed.length}`,
  );
  select(ns, renderer);
  assert.equal(log.held.length, 0, "and only once");
}

/** The hi words of the GlobeTerrain modules a device was asked for. */
function moduleHiWords(log) {
  return log.shaderModules.map((m) => {
    const match = /hi=0x([0-9a-f]+)/.exec(m.label ?? "");
    return match ? parseInt(match[1], 16) : 0;
  });
}

/**
 * Water round 6 (seat ruling R-2026-10-23-S8): the opt-in parity ocean. The
 * WATER_PROVIDER_PARITY hi bit is set only while the tile provider carries a
 * `waterClassificationProvider` (what `Globe.beginFrame` hands it for
 * `globalWaterMask` once loaded, or `lakeWaterMask` / `riverWaterMask` once
 * loaded over a terrain or global mask) and enhanced ocean is off. At
 * defaults no module or pipeline carries it.
 */
async function scenarioWaterProviderParity(ns) {
  const PARITY = ns.ShaderDefineHi.WATER_PROVIDER_PARITY;
  const ENHANCED = ns.ShaderDefineHi.ENHANCED_OCEAN;
  // The resolver and the hi word, executed.
  assert.equal(ns.resolveWaterProviderParity(undefined), false);
  assert.equal(ns.resolveWaterProviderParity({}), false);
  assert.equal(
    ns.resolveWaterProviderParity({ waterClassificationProvider: undefined }),
    false,
  );
  assert.equal(
    ns.resolveWaterProviderParity({ waterClassificationProvider: null }),
    false,
  );
  assert.equal(
    ns.resolveWaterProviderParity({ waterClassificationProvider: {} }),
    true,
  );
  assert.equal(ns.oceanDefinesHi({}), 0);
  assert.equal(
    ns.oceanDefinesHi({ _waterProviderParityEnabled: true }),
    PARITY,
  );
  assert.equal(
    ns.oceanDefinesHi({
      _enhancedOceanEnabled: true,
      _waterProviderParityEnabled: true,
    }),
    ENHANCED,
  );

  // Through the renderer.
  const { renderer, log } = boot(ns);
  const defaults = provider(false);
  tick(renderer, defaults, { frameNumber: 1 });
  select(ns, renderer);
  await flush();
  tick(renderer, defaults, { frameNumber: 2 });
  const shipped = select(ns, renderer);
  assert.ok(shipped, "the default pipeline resolves");
  assert.doesNotMatch(shipped.label, /wpp/);
  assert.ok(
    moduleHiWords(log).every((hi) => (hi & PARITY) === 0),
    "no module carries the parity bit at defaults",
  );

  const fed = { enableEnhancedOcean: false, waterClassificationProvider: {} };
  tick(renderer, fed, { frameNumber: 3 });
  assert.equal(
    select(ns, renderer),
    shipped,
    "the shipped pipeline keeps drawing while the parity variant compiles",
  );
  await flush();
  tick(renderer, fed, { frameNumber: 4 });
  const parity = select(ns, renderer);
  assert.ok(parity && /, wpp/.test(parity.label), "the parity pipeline draws");
  assert.ok(
    moduleHiWords(log).some((hi) => hi === PARITY),
    "a module was built at the parity hi word",
  );

  tick(renderer, defaults, { frameNumber: 5 });
  await flush();
  tick(renderer, defaults, { frameNumber: 6 });
  const back = select(ns, renderer);
  assert.ok(
    back && !/wpp/.test(back.label),
    "the provider gone, the default returns",
  );

  const before = log.shaderModules.length;
  const enhancedFed = {
    enableEnhancedOcean: true,
    waterClassificationProvider: {},
  };
  tick(renderer, enhancedFed, { frameNumber: 7 });
  select(ns, renderer);
  await flush();
  tick(renderer, enhancedFed, { frameNumber: 8 });
  select(ns, renderer);
  for (const hi of moduleHiWords(log).slice(before)) {
    if ((hi & ENHANCED) !== 0) {
      assert.equal(
        hi & PARITY,
        0,
        "the enhanced modules never carry the parity bit",
      );
    }
  }
}

// ───────────────────────────── the tests ───────────────────────────────────

const SCENARIOS = [
  [
    "C3 the fade is 1.0 while pending, then a monotonic smoothstep to 0 within 600 ms",
    scenarioFade,
  ],
  [
    "H-01 a resolution from an entry the flip dropped is ignored",
    scenarioStale,
  ],
  ["C4 a rejected compile abandons the fade", scenarioFailure],
  [
    "C4 a fade whose pipelines never land is abandoned at the timeout",
    scenarioTimeout,
  ],
  [
    "C4 400 tiles ask for one afterRender callback a frame",
    scenarioFrameRequest,
  ],
  [
    "H-14 the deficit is a pure function of the frame's clock sample",
    scenarioClockSampling,
  ],
  [
    "C7 the tier decision: enter 500 m, leave 1500 m, warm under 5000 m",
    scenarioTierDecision,
  ],
  ["C7 Tier 2 candidates are held until the eye is near", scenarioWarmPlan],
  [
    "compound flips: an empty cache keeps the first flip's fallbacks",
    scenarioStash,
  ],
];

for (const [name, scenario] of SCENARIOS) {
  test(name, async () => {
    scenario(await importRenderer());
  });
}

test("C6 a first request for an uncached key under enhanced ocean creates nothing synchronously", async () => {
  await scenarioNoSyncCreation(await importRenderer());
});

test("C6 a cached classic pipeline is the fallback, again with nothing created synchronously", async () => {
  await scenarioCachedFallback(await importRenderer());
});

test("C3 turning enhanced on at run time fades over the window through the renderer", async () => {
  await scenarioRuntimeFlip(await importRenderer());
});

test("H-01 through the renderer: a late resolution from before an off/on flip is ignored", async () => {
  await scenarioRuntimeStale(await importRenderer());
});

test("C4 through the renderer: 400 tiles x 60 frames push one callback a frame and a rejection ends the fade", async () => {
  await scenarioRuntimeFrames(await importRenderer());
});

test("C4 through the renderer: pipelines that never land are abandoned at the timeout", async () => {
  await scenarioRuntimeTimeout(await importRenderer());
});

test("compound flip through the renderer: enhanced on with the eye underwater keeps the classic fallback", async () => {
  await scenarioCompoundFlip(await importRenderer());
});

test("C7 a 20 km camera compiles no Tier 2 module and schedules no timer; descending warms it once", async () => {
  await scenarioTier2Warm(await importRenderer());
});

test("A4 the tide CPU work and float 493 follow enhanced ocean, the Earth ellipsoid and their own gates", async () => {
  scenarioTideGate(await importTileUb());
});

test("FND-4 enhanced ocean on from frame 1 draws the classic pipeline until its own lands, through the timeout", async () => {
  await scenarioBootstrapFallback(await importRenderer());
});

test("FND-4 under enhanced ocean the speculative warms wait for the entry's own pipeline", async () => {
  await scenarioDeferredSpeculativeWarm(await importRenderer());
});

test("water round 6: the WATER_PROVIDER_PARITY bit is set only while a water classification provider feeds the globe, never under enhanced ocean", async () => {
  await scenarioWaterProviderParity(await importRenderer());
});

// ───────────────────────────── inertness mutants ───────────────────────────
// Each mutant makes ONE clause unreachable and requires the scenario that pins
// it to fail. A scenario that stays green here is not testing the clause.

const TIERS = "WebGPUGlobeSurfaceOceanTiers.ts";
const PIPELINES = "WebGPUGlobeSurfacePipelines.ts";
const RENDERER = "WebGPUGlobeSurfaceRenderer.ts";
const TILE_UB = "WebGPUGlobeSurfaceTileUB.ts";

const MUTANTS = [
  {
    name: "FND-4 classic bootstrap request unreachable",
    scenarios: [scenarioBootstrapFallback],
    override: swap(
      PIPELINES,
      "  pipelineCache\n    .getPipeline(tier0Descriptor)\n    .then((tier0) => {",
      "  (false ? pipelineCache.getPipeline(tier0Descriptor) : new Promise(() => {}))\n    .then((tier0) => {",
      "fnd4-bootstrap",
    ),
  },
  {
    name: "FND-4 speculative warms on first request under enhanced ocean",
    scenarios: [scenarioDeferredSpeculativeWarm],
    override: swap(
      PIPELINES,
      "  const speculativeWarmDue = host._enhancedOceanEnabled\n",
      "  const speculativeWarmDue = false && host._enhancedOceanEnabled\n",
      "fnd4-warm-defer",
    ),
  },
  {
    name: "N2 speculative warms fire while only the fallback draws (O8)",
    scenarios: [scenarioDeferredSpeculativeWarm],
    override: swap(
      PIPELINES,
      "    ? pipeline !== null &&\n      pipeline === entry.pipeline &&\n",
      "    ? pipeline !== null &&\n      (true || pipeline === entry.pipeline) &&\n",
      "n2-warm-own-pipeline",
    ),
  },
  {
    name: "water round 6: the parity resolver ignores the provider",
    scenarios: [scenarioWaterProviderParity],
    override: swap(
      "WebGPUGlobeSurfaceShaders.ts",
      "  return (\n    tileProvider?.waterClassificationProvider !== undefined &&\n",
      "  return false && (\n    tileProvider?.waterClassificationProvider !== undefined &&\n",
      "wpp-resolver-off",
    ),
  },
  {
    name: "water round 6: the parity bit set at defaults",
    scenarios: [scenarioWaterProviderParity],
    override: swap(
      "WebGPUGlobeSurfaceShaders.ts",
      "    return host._waterProviderParityEnabled\n",
      "    return true || host._waterProviderParityEnabled\n",
      "wpp-always",
    ),
  },
  {
    name: "water round 6: the renderer never mirrors the provider",
    scenarios: [scenarioWaterProviderParity],
    override: swap(
      RENDERER,
      "    this._applyWaterProviderParityState(\n      resolveWaterProviderParity(tileProvider),\n    );\n",
      "    if (false) {\n      this._applyWaterProviderParityState(\n        resolveWaterProviderParity(tileProvider),\n      );\n    }\n",
      "wpp-unmirrored",
    ),
  },
  {
    name: "stale-resolution guard unreachable",
    scenarios: [scenarioStale, scenarioFade, scenarioRuntimeStale],
    override: swap(
      TIERS,
      "    if (entry.oceanGeneration !== this._generation || !entry.builtEnhanced) {\n      return;\n    }\n    this._resolvedEnhanced = true;",
      "    if (false && (entry.oceanGeneration !== this._generation || !entry.builtEnhanced)) {\n      return;\n    }\n    this._resolvedEnhanced = true;",
      "stale-guard",
    ),
  },
  {
    name: "deficit forced to 0",
    scenarios: [scenarioFade, scenarioRuntimeFlip],
    override: swap(
      TIERS,
      "  get deficit(): number {\n    if (this._pending) {",
      "  get deficit(): number {\n    if (true) {\n      return 0;\n    }\n    if (this._pending) {",
      "deficit-zero",
    ),
  },
  {
    name: "packed deficit zeroed at the renderer",
    scenarios: [scenarioRuntimeFlip],
    override: swap(
      RENDERER,
      "    return this._oceanTier.deficit;",
      "    return 0;",
      "renderer-deficit-zero",
    ),
  },
  {
    name: "afterRender once-per-frame guard unreachable",
    scenarios: [scenarioFrameRequest, scenarioRuntimeFrames],
    override: swap(
      TIERS,
      "    if (!afterRender.includes(this._frameRequest)) {",
      "    if (true) {",
      "frame-request-guard",
    ),
  },
  {
    name: "failure notification unreachable",
    scenarios: [scenarioFailure],
    override: swap(
      TIERS,
      "  noteFailed(entry: OceanStampedEntry): void {\n",
      "  noteFailed(entry: OceanStampedEntry): void {\n    if (entry) {\n      return;\n    }\n",
      "note-failed",
    ),
  },
  {
    name: "rejection never reaches the tier state",
    scenarios: [scenarioRuntimeFrames],
    override: swap(
      PIPELINES,
      "          entry.pending = false;\n          host._noteEnhancedOceanPipelineFailed?.(entry);",
      "          entry.pending = false;",
      "catch-notify",
    ),
  },
  {
    name: "pending timeout unreachable",
    scenarios: [scenarioTimeout, scenarioRuntimeTimeout],
    override: swap(
      TIERS,
      "      this._pending &&\n      now - this._pendingSinceMs >= OCEAN_TRANSITION_PENDING_TIMEOUT_MS",
      "      false &&\n      this._pending &&\n      now - this._pendingSinceMs >= OCEAN_TRANSITION_PENDING_TIMEOUT_MS",
      "timeout",
    ),
  },
  {
    name: "clock resampled on every read",
    scenarios: [scenarioClockSampling],
    override: swap(
      TIERS,
      "    if (key === this._frameKey) {\n      return;\n    }",
      "    if (false && key === this._frameKey) {\n      return;\n    }",
      "frame-key",
    ),
  },
  {
    name: "entries never stamped",
    scenarios: [scenarioRuntimeFlip, scenarioRuntimeStale],
    override: swap(
      PIPELINES,
      "  host._stampOceanPipelineEntry?.(entry);\n",
      "",
      "stamp",
    ),
  },
  {
    name: "fallback pipeline never returned while pending",
    scenarios: [scenarioCachedFallback, scenarioRuntimeFlip],
    override: swap(
      PIPELINES,
      "    if (entry.fallbackPipeline) {\n      return entry.fallbackPipeline;\n    }",
      "    if (false && entry.fallbackPipeline) {\n      return entry.fallbackPipeline;\n    }",
      "fallback-return",
    ),
  },
  {
    name: "synchronous bootstrap creation restored",
    scenarios: [scenarioNoSyncCreation],
    override: swap(
      PIPELINES,
      "    host._noteEnhancedOceanFallbackUsed?.();\n    return tier0Sync;\n  }\n  pipelineCache\n    .getPipeline(tier0Descriptor)",
      "    host._noteEnhancedOceanFallbackUsed?.();\n    return tier0Sync;\n  }\n  return host._device!.createRenderPipeline(\n    descriptorToGPU(tier0Descriptor),\n  );\n  pipelineCache\n    .getPipeline(tier0Descriptor)",
      "sync-bootstrap",
    ),
  },
  {
    name: "Tier 2 warm not gated on the eye",
    scenarios: [scenarioTier2Warm],
    override: swap(
      PIPELINES,
      "host._underwaterWarmPlan?.noteCandidate(cacheKey, candidate)",
      "(host._underwaterWarmPlan?.noteCandidate(cacheKey, candidate), true)",
      "warm-gate",
    ),
  },
  {
    name: "Tier 2 warm eligibility always true",
    scenarios: [scenarioTierDecision, scenarioTier2Warm],
    override: swap(
      TIERS,
      "      warmEligible: eyeHeight < UNDERWATER_WARM_ELIGIBLE_M,",
      "      warmEligible: true,",
      "warm-eligible",
    ),
  },
  {
    name: "held candidates never released",
    scenarios: [scenarioWarmPlan, scenarioTier2Warm],
    override: swap(
      TIERS,
      "    const released = Array.from(this._candidates.values());",
      "    const released: UnderwaterWarmCandidate[] = [];",
      "release",
    ),
  },
  {
    name: "exit hysteresis removed",
    scenarios: [scenarioTierDecision, scenarioTier2Warm],
    override: swap(
      TIERS,
      "    const threshold = active\n      ? UNDERWATER_OPTICS_EXIT_M\n      : UNDERWATER_OPTICS_ENTER_M;",
      "    const threshold = UNDERWATER_OPTICS_ENTER_M;",
      "hysteresis",
    ),
  },
  {
    name: "_applyUnderwaterOpticsState returns early",
    scenarios: [scenarioTier2Warm, scenarioCompoundFlip],
    override: swap(
      RENDERER,
      "  public _applyUnderwaterOpticsState(enabled: boolean): void {\n",
      "  public _applyUnderwaterOpticsState(enabled: boolean): void {\n    if (enabled !== undefined) {\n      return;\n    }\n",
      "apply-underwater",
    ),
  },
  {
    name: "empty-cache stash clears the fallbacks",
    scenarios: [scenarioStash, scenarioCompoundFlip],
    override: swap(
      TIERS,
      "  if (pipelineCache.size === 0) {\n    return;\n  }\n  fallbackCache.clear();",
      "  fallbackCache.clear();",
      "stash",
    ),
  },
];

for (const mutant of MUTANTS) {
  test(`mutant: ${mutant.name} turns a scenario red`, async () => {
    const ns = await importRenderer([mutant.override]);
    for (const scenario of mutant.scenarios) {
      // An AssertionError, not a crash: the scenario must fail by noticing.
      await assert.rejects(
        async () => scenario(ns),
        { name: "AssertionError" },
        `${scenario.name} must fail with "${mutant.name}", or it does not pin the clause`,
      );
    }
  });
}

const TILE_UB_MUTANTS = [
  {
    name: "tide gate ignores enhanced ocean",
    override: swap(
      TILE_UB,
      "  if (showReflectiveOcean && enhancedOceanOn) {\n    if (tileProvider?.oceanTideEnabled",
      "  if (showReflectiveOcean && (enhancedOceanOn || true)) {\n    if (tileProvider?.oceanTideEnabled",
      "tide-enhanced-gate",
    ),
  },
  {
    name: "tide evaluated on any ellipsoid",
    override: swap(
      TILE_UB,
      "        isEarthEllipsoid(ellipsoid) &&\n",
      "",
      "tide-earth-gate",
    ),
  },
  {
    name: "surge shares the tide gate",
    override: swap(
      TILE_UB,
      "    const pressure = tileProvider.oceanMeanSeaLevelPressure;\n    if (typeof pressure",
      "    const pressure =\n      tileProvider?.oceanTideEnabled === false\n        ? undefined\n        : tileProvider.oceanMeanSeaLevelPressure;\n    if (typeof pressure",
      "surge-gate",
    ),
  },
];

for (const mutant of TILE_UB_MUTANTS) {
  test(`mutant: ${mutant.name} turns the tide gate scenario red`, async () => {
    const ns = await importTileUb([mutant.override]);
    await assert.rejects(
      async () => scenarioTideGate(ns),
      { name: "AssertionError" },
      `scenarioTideGate must fail with "${mutant.name}"`,
    );
  });
}
