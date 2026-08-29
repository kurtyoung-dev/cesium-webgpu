// globe-pipeline-prewarm.spec.mjs — browser-free contract for WHEN the globe's
// first-frame pipeline variants are pre-cooked, and for the cache key they are
// cooked under. Pure Node: no browser, no GPU, no build.
//
// @purpose Replays the runtime MSAA sample-count sequencing a context and its scene renderer produce, and requires the globe's first pipeline requests to be served by the warm rather than compiled on the render path.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// A globe pipeline bakes the scene target's colour format and its MSAA sample
// count, and the sample count lands in TWO places the central pipeline cache
// keys on: the descriptor name (`, samples=N`) and `multisample.count`. A
// context's sample count is its own default until the scene renderer writes the
// scene's requested count at the top of the first frame — 1 at init against a
// default scene's 4 — so a warm placed at context init produces pipelines under
// a key nothing ever asks for. Cached, counted as created, and never served.
//
// That is not hypothetical: it is what an earlier init-time warm did, and the
// spec that covered it could not see the defect because it handed the warm and
// the request the same sample count. Both sides agreed by construction, so the
// test certified the brief instead of the runtime.
//
// This file therefore replays the asymmetry rather than assuming it away:
//
//   * `context._msaaSamples` comes from a REAL `WebGPUContext` instance's own
//     field initialiser — executed, not copied.
//   * the first-frame value comes from the REAL `WebGPUSceneRenderer`
//     `prepareFrame`, computed from a scene-shaped object the way a viewer's
//     `Scene` presents itself.
//   * the warm is reached exactly as production reaches it — through the seam at
//     the end of `prepareFrame`, its dynamic import, and the device-keyed
//     renderer the context's init-time warm created.
//   * the request is `selectPipeline`, driven with the argument shape
//     `createTileCommands` uses, through the REAL central cache.
//
// A test that cannot fail for the original reason is not a test, so E2 runs the
// removed shape — warm at init — and REQUIRES nothing to be served.
//
// ── WHAT IS MIRRORED RATHER THAN EXECUTED, AND WHY ──────────────────────────
//
// Two things. Both are named here rather than hidden, and both are guarded.
//
//   1. The `WebGPUContext` CONSTRUCTOR BODY is neutralised after `super()`, so a
//      context can be constructed without a canvas, a device or a WebGL
//      compatibility stub. Class FIELD INITIALISERS still run — they are where
//      `_msaaSamples`, `_sceneColorFormat` and `_logDepthWriteEnabled` come
//      from — and every getter read here (`fragmentDepth`,
//      `scenePipelineFormat`, `webgpuPipelineCache`) is the real one on the real
//      prototype.
//
//   2. The four lines `createTileCommands` runs on its first frame, where the
//      scene-format generation differs and the renderer adopts the context's
//      colour format, sample count and log-depth state and clears its local
//      cache. Driving the real block needs a whole tile fixture. The mirror's
//      INPUTS are the real context, E5b pins the mirror against the real source
//      so a drift fails loudly, and E4 flips one mirrored input to prove the
//      cache key reads it.
//
// Run: node --test Tools/visual-regression/globe-pipeline-prewarm.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineSource = resolve(directory, "../../packages/engine/Source");
const engineWebGPU = resolve(engineSource, "Renderer/WebGPU");
const engineScene = resolve(engineSource, "Scene");
const engineRenderer = resolve(engineSource, "Renderer");
const engineCore = resolve(engineSource, "Core");

const GLOBE_RENDERER_PATH = resolve(
  engineWebGPU,
  "WebGPUGlobeSurfaceRenderer.ts",
);
const TERRAIN_ENCODING_PATH = resolve(engineCore, "TerrainEncoding.js");
const TERRAIN_FILL_MESH_PATH = resolve(engineScene, "TerrainFillMesh.js");
const HEIGHTMAP_TERRAIN_DATA_PATH = resolve(
  engineCore,
  "HeightmapTerrainData.js",
);
const SCENE_PATH = resolve(engineScene, "Scene.js");

/**
 * Reads a source file and normalises its line terminators, so anchors in this
 * file match regardless of the checkout's autocrlf setting.
 *
 * @param {string} path Absolute path to read.
 * @returns {Promise<string>} LF-normalised source.
 */
async function readSource(path) {
  return (await readFile(path, "utf8")).split("\r\n").join("\n");
}

const GLOBE_RENDERER_SOURCE = await readSource(GLOBE_RENDERER_PATH);
const TERRAIN_ENCODING_SOURCE = await readSource(TERRAIN_ENCODING_PATH);
const TERRAIN_FILL_MESH_SOURCE = await readSource(TERRAIN_FILL_MESH_PATH);
const HEIGHTMAP_TERRAIN_DATA_SOURCE = await readSource(
  HEIGHTMAP_TERRAIN_DATA_PATH,
);
const SCENE_SOURCE = await readSource(SCENE_PATH);

// One synthetic entry so the context, the scene renderer, the globe renderer,
// the pipeline factory, the shader-module cache and the central cache all come
// from a SINGLE module graph. Two bundles would give the warm and the request
// two copies of the module cache, and the shader-identity fold in the cache key
// would then separate keys that are one key at runtime — the test would pass or
// fail for a reason the harness invented.
const ENTRY_PATH = resolve(engineWebGPU, "__globe-pipeline-prewarm.ts");
const ENTRY_SOURCE = [
  'export { WebGPUContext } from "./WebGPUContext.js";',
  'export { WebGPUSceneRenderer } from "./WebGPUSceneRenderer.js";',
  'export { WebGPUGlobeSurfaceRenderer } from "./WebGPUGlobeSurfaceRenderer.js";',
  "export {",
  "  selectPipeline,",
  "  DEFAULT_GLOBE_PIPELINE_PREWARM,",
  '} from "./WebGPUGlobeSurfacePipelines.js";',
  'export { WebGPURenderPipelineCache } from "./WebGPURenderPipelineCache.js";',
  'export { isWebGPULogDepthActive } from "./WebGPULogDepth.js";',
  "export {",
  "  warmUpGlobeRenderer,",
  "  warmUpGlobePipelines,",
  '} from "../../Scene/GlobeSurfaceTileProviderRendering.js";',
  'export { default as FeatureRendererKey } from "../FeatureRendererKey.js";',
  "",
].join("\n");

// Everything the warm and the request both touch is real. `GraphicsContext` is
// real because a stubbed base class turns `super()` into a Proxy and the derived
// field initialisers then land on it rather than on the instance — which would
// silently replace the very value under test.
const REAL = [
  "WebGPUGlobeSurfacePipelines.ts",
  "WebGPUGlobeSurfacePipelineKey.ts",
  "WebGPUGlobeSurfaceShaders.ts",
  "WebGPUGlobeSurfaceTypes.ts",
  "WebGPUShaderModuleCache.ts",
  "WebGPUShaderPreprocessor.ts",
  "WebGPUShaderDefines.ts",
  "WebGPURenderPipelineCache.ts",
  "WebGPUDeviceInvalidationBus.ts",
  "AsyncResourceMonitor.ts",
  "WebGPUGlobeSurfaceRenderer.ts",
  "WebGPULogDepth.ts",
  "WebGPUContext.ts",
  "GraphicsContext.ts",
  "WebGPUSceneRenderer.ts",
  "GlobeSurfaceTileProviderRendering.js",
  "FeatureRendererKey.js",
  "Pass.js",
  "SceneMode.js",
  "defined.js",
];

// esbuild resolves in parallel, so a stub can be materialised before the real
// file that imports the most from it is loaded. Naming the big importers here
// makes the stub surface deterministic instead of order-dependent.
const PRESEED = [
  resolve(engineWebGPU, "WebGPUContext.ts"),
  resolve(engineWebGPU, "WebGPUSceneRenderer.ts"),
  resolve(engineWebGPU, "WebGPUGlobeSurfaceRenderer.ts"),
  resolve(engineWebGPU, "WebGPUGlobeSurfacePipelines.ts"),
  resolve(engineWebGPU, "WebGPURenderPipelineCache.ts"),
  resolve(engineRenderer, "GraphicsContext.ts"),
  resolve(engineScene, "GlobeSurfaceTileProviderRendering.js"),
];

// See "WHAT IS MIRRORED" above. The `if` keeps the parameter used, so the
// neutralised constructor still reads as a function of its arguments.
const NEUTRALISE_CONTEXT_CONSTRUCTOR = {
  basename: "WebGPUContext.ts",
  label: "context-constructor-body-neutralised",
  mutate: (source) =>
    source.replace(
      "    this._canvas = canvas;\n    this._options = options;",
      "    if (canvas === undefined) {\n      return;\n    }\n    return;\n    this._options = options;",
    ),
};

// A minimal but syntactically real WGSL body, with no `//>>ifdef` directives, so
// the preprocessor passes it through unchanged and the module cache keys purely
// on (sourceId, defines).
const FAKE_WGSL =
  "@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1.0); }\n";

/**
 * A device fake with the surface the globe renderer's `initialize`, the shader
 * cache and the central pipeline cache touch. Every created object is a fresh
 * identity, which is what lets a test assert that the pipeline a request was
 * served IS the one the warm built.
 *
 * @returns {object} The fake device plus its call logs.
 */
function makeFakeDevice() {
  const shaderModules = [];
  const pipelines = [];
  const device = {
    limits: { maxSampledTexturesPerShaderStage: 32 },
    features: new Set(),
    queue: { writeBuffer() {}, writeTexture() {}, submit() {} },
    createShaderModule(descriptor) {
      const module = { __kind: "shader", label: descriptor.label };
      shaderModules.push(module);
      return module;
    },
    createRenderPipeline(descriptor) {
      const pipeline = { __kind: "pipeline", label: descriptor.label };
      pipelines.push(pipeline);
      return pipeline;
    },
    createRenderPipelineAsync(descriptor) {
      const pipeline = { __kind: "pipeline", label: descriptor.label };
      pipelines.push(pipeline);
      return Promise.resolve(pipeline);
    },
    createBindGroupLayout() {
      return { __kind: "bindGroupLayout" };
    },
    createPipelineLayout() {
      return { __kind: "pipelineLayout" };
    },
    createSampler() {
      return { __kind: "sampler" };
    },
    createTexture() {
      return {
        __kind: "texture",
        createView: () => ({ __kind: "textureView" }),
        destroy() {},
      };
    },
    createBuffer() {
      return { __kind: "buffer", destroy() {} };
    },
    pushErrorScope() {},
    popErrorScope() {
      return Promise.resolve(null);
    },
  };
  return { device, shaderModules, pipelines };
}

/**
 * Yields to the event loop until the cache has finished creating `count`
 * pipelines, and fails rather than letting a later assertion read a half-built
 * cache and report a mismatch that is really a race.
 *
 * @param {object} cache The central pipeline cache.
 * @param {number} count How many creations to wait for.
 * @param {string} what What is being waited on, for the failure message.
 */
async function settle(cache, count, what) {
  for (let i = 0; i < 200; i++) {
    if (cache.getStats().created >= count) {
      return;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.fail(
    `${what}: the cache never finished ${count} creations ` +
      `(created ${cache.getStats().created})`,
  );
}

/**
 * Yields a fixed number of times, for the legs that must show that nothing
 * happened. A count rather than a condition, because there is no condition to
 * wait for — only the absence of one.
 */
async function drain() {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Builds a context, a globe renderer and a scene renderer the way a WebGPU
 * viewer's boot does, and stops just before the first frame.
 *
 * `warmUpGlobeRenderer` is the context's own init-time warm: it constructs the
 * device-keyed renderer through the registered feature-renderer descriptor and
 * runs the real `initialize`. The RendererClass registered here is a subclass
 * that records the instance, because the WeakMap holding it is module-private —
 * construction, initialization and every later lookup are the production ones.
 *
 * @param {Record<string, unknown>} namespace The bundled namespace.
 * @returns {object} The context, renderer, scene renderer and device.
 */
function boot(namespace) {
  const { device, shaderModules, pipelines } = makeFakeDevice();
  const context = new namespace.WebGPUContext({}, {});
  context._device = device;
  // `warmUpGlobeRenderer` reads this before falling back to
  // `navigator.gpu.getPreferredCanvasFormat()`, which does not exist in Node.
  context.canvasFormat = "bgra8unorm";

  let renderer = null;
  class CapturingGlobeRenderer extends namespace.WebGPUGlobeSurfaceRenderer {
    constructor(...args) {
      super(...args);
      renderer = this;
    }
  }
  context.registerFeatureRenderer(namespace.FeatureRendererKey.GLOBE_SURFACE, {
    RendererClass: CapturingGlobeRenderer,
    getShaderCode: () => FAKE_WGSL,
  });
  namespace.warmUpGlobeRenderer(context);

  const sceneRenderer = new namespace.WebGPUSceneRenderer();
  // The scene framebuffer reports the colour format the scene target settled
  // on. Supplied rather than allocated: the real one needs a device that can
  // create textures with real formats. This is the SDR case, where the scene
  // target takes the canvas format.
  sceneRenderer._sceneFramebuffer = {
    update() {},
    colorFormat: "bgra8unorm",
  };
  context._canvas = { width: 1024, height: 640 };

  return { context, renderer, sceneRenderer, device, shaderModules, pipelines };
}

/**
 * A scene-shaped object with the fields `prepareFrame` and the warm read.
 *
 * @param {number} msaaSamples The scene's requested sample count.
 * @param {boolean} [withGlobe] Whether the scene has a globe.
 * @returns {object} The scene-shaped object.
 */
function makeScene(msaaSamples, withGlobe = true) {
  return {
    msaaSamples,
    taaEnabled: false,
    globe: withGlobe ? { enableEnhancedOcean: false } : undefined,
    // A default viewer resolves log depth ON: `Scene.defaultLogDepthBuffer` is
    // true, a WebGPU context's `fragmentDepth` is true, and a default camera's
    // frustum is perspective. E1 asserts that through the real gate rather than
    // trusting this literal.
    frameState: { useLogDepth: true },
  };
}

/**
 * Replays the adoption `createTileCommands` performs on its first frame, when
 * the renderer's scene-format generation differs from the context's: it takes
 * the context's colour format and sample count, resolves the log-depth gate,
 * and clears the renderer-local pipeline cache.
 *
 * Every value is re-derived from the context, NOT read back off the prewarm, so
 * the request side shares no state with the warm and an agreement between them
 * is a fact about the cache key rather than about this function.
 *
 * @param {Record<string, unknown>} namespace The bundled namespace.
 * @param {object} renderer The globe renderer.
 * @param {object} context The context.
 * @param {object} frameState The frame state.
 * @param {number} [sampleCountOverride] Request-side sample count, for E4.
 */
function adoptSceneTargetAsATileWould(
  namespace,
  renderer,
  context,
  frameState,
  sampleCountOverride,
) {
  // The lazy central-cache capture the same method performs, under the same
  // `if (!this._centralPipelineCache)` guard: a globe that already has one
  // keeps it. Without this line a renderer with no cache falls back to
  // synchronous creation and every request looks served.
  renderer._centralPipelineCache =
    renderer._centralPipelineCache ?? context.webgpuPipelineCache ?? null;
  renderer._canvasFormat =
    context.scenePipelineFormat ?? renderer._canvasFormat;
  renderer._sampleCount = sampleCountOverride ?? context._msaaSamples ?? 1;
  renderer._logDepthEnabled = namespace.isWebGPULogDepthActive(
    context,
    frameState,
  );
  renderer._pipelineCache.clear();
}

/**
 * Requests one variant the way the opaque first colour pass of a tile does:
 * cull back, no clip distances, no geodetic surface normals, not a subsequent
 * imagery pass and not a translucent globe.
 *
 * @param {Record<string, unknown>} namespace The bundled namespace.
 * @param {object} renderer The globe renderer.
 * @param {object} variant One `DEFAULT_GLOBE_PIPELINE_PREWARM` entry.
 * @returns {object|null} The pipeline, or null while it is still cooking.
 */
function requestPipelineAsATileWould(namespace, renderer, variant) {
  return namespace.selectPipeline(
    renderer,
    variant.isQuantized,
    variant.hasNormals,
    variant.hasWebMercatorT,
    false,
    variant.strideBytes,
    false,
    false,
    false,
  );
}

/**
 * Runs every prewarm variant through the request path and reports, per variant,
 * whether the central cache served it synchronously.
 *
 * @param {Record<string, unknown>} namespace The bundled namespace.
 * @param {object} renderer The globe renderer.
 * @param {object} cache The central cache.
 * @returns {object} The per-variant results and the hit delta.
 */
function requestFirstFrameVariants(namespace, renderer, cache) {
  const before = { ...cache.getStats() };
  const served = [];
  for (const variant of namespace.DEFAULT_GLOBE_PIPELINE_PREWARM) {
    const pipeline = requestPipelineAsATileWould(namespace, renderer, variant);
    served.push([variant.label, pipeline !== null, pipeline]);
  }
  const after = cache.getStats();
  return { served, hitDelta: after.hits - before.hits };
}

/**
 * Bundles the acceptance graph, optionally through extra source mutations.
 *
 * @param {Array} [extraOverrides] Rewrites applied to real dependencies.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
function importPrewarmGraph(extraOverrides = []) {
  return bundle({
    path: ENTRY_PATH,
    source: ENTRY_SOURCE,
    real: REAL,
    preseed: PRESEED,
    overrides: [NEUTRALISE_CONTEXT_CONSTRUCTOR, ...extraOverrides],
  });
}

/**
 * The MSAA sample count a `Scene` gives itself when the caller names none,
 * read out of the real `Scene.js` line rather than copied. A change to that
 * default therefore moves this spec with it instead of leaving a stale literal
 * behind, and a change to the SHAPE of the line fails loudly rather than
 * silently reverting to a guess.
 *
 * @returns {number} The default.
 */
function sceneMsaaSamplesDefault() {
  const match = SCENE_SOURCE.match(
    /this\._msaaSamples = options\.msaaSamples \?\? (\d+);/,
  );
  assert.ok(
    match,
    "Scene.js no longer takes its sample count from an " +
      "`options.msaaSamples ?? N` default — the shape this spec reads has " +
      "moved and the sequencing it replays may no longer be the runtime's",
  );
  return Number(match[1]);
}

// ───────────────────── E1: the acceptance condition ─────────────────────────

test("E1 the globe's first pipeline requests are served by the warm", async () => {
  const namespace = await importPrewarmGraph();
  const { context, renderer, sceneRenderer } = boot(namespace);

  // The left half of the asymmetry, executed: a real context's own field
  // initialiser, on a real instance, over the real GraphicsContext base.
  assert.equal(
    context._msaaSamples,
    1,
    "a context initialises its sample count to 1; if that changed, the " +
      "sequencing this spec replays is no longer the runtime's",
  );

  const sceneSamples = sceneMsaaSamplesDefault();
  assert.notEqual(
    sceneSamples,
    context._msaaSamples,
    "the scene default and the context default must DIFFER, or this spec is " +
      "the harness-supplied-context defect it exists to prevent: both sides " +
      "would agree by construction and a warm at init would look correct",
  );

  const scene = makeScene(sceneSamples);
  const cache = context.webgpuPipelineCache;
  assert.ok(cache, "the context must publish a central pipeline cache");
  assert.equal(
    cache.getStats().created,
    0,
    "nothing may be pre-cooked before the first frame runs",
  );

  // The right half, executed: the real first `prepareFrame`, which computes the
  // requested count from the scene and writes it onto the context — and, at its
  // end, reaches the warm.
  sceneRenderer.prepareFrame({ scene, context, useHDR: false });
  assert.equal(
    context._msaaSamples,
    sceneSamples,
    "the first frame must write the scene's requested sample count",
  );

  await settle(cache, namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.length, "E1");
  const warmed = cache.listPipelineVariants();
  assert.equal(
    warmed.length,
    namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.length,
    "every first-frame variant must be warmed",
  );
  for (const row of warmed) {
    assert.match(
      row.key,
      new RegExp(`samples=${sceneSamples}\\b`),
      "a warmed key must carry the sample count the frame requested, not the " +
        `context's init default — got ${row.key}`,
    );
  }
  const warmedKeys = new Set(warmed.map((row) => row.key));
  const warmedPipelines = new Set(warmed.map((row) => row.pipeline));

  // The request side, re-derived from the context alone.
  adoptSceneTargetAsATileWould(
    namespace,
    renderer,
    context,
    scene.frameState,
    undefined,
  );
  assert.equal(
    renderer._logDepthEnabled,
    true,
    "a default WebGPU viewer resolves log depth ON through the real gate; if " +
      "this is false the warm and the request are agreeing on the wrong " +
      "define set and the premise has moved",
  );

  const { served, hitDelta } = requestFirstFrameVariants(
    namespace,
    renderer,
    cache,
  );
  assert.deepEqual(
    served.map(([label, hit]) => [label, hit]),
    namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.map((variant) => [
      variant.label,
      true,
    ]),
    "every first-frame variant must be served from the warm",
  );
  assert.equal(
    hitDelta,
    namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.length,
    "each request must be a cache HIT, not a fresh build",
  );
  for (const [label, , pipeline] of served) {
    assert.ok(
      warmedPipelines.has(pipeline),
      `${label} was served a pipeline the warm did not build`,
    );
  }

  // Speculative builds must not hold the frame-readiness gate open. Asserted
  // while builds really are inflight — `selectPipeline` warms the blend
  // counterpart of each opaque variant on its first request, so there is a
  // deterministic window here with background work pending.
  assert.ok(
    cache.getStats().pending > 0,
    "vacuity check: background warms must still be inflight for the next " +
      "assertion to say anything",
  );
  assert.equal(
    context.pendingResourceCount,
    0,
    "a background warm must not raise the context's foreground pending " +
      "count — `Scene.renderReady` reads it, and a warm that held it open " +
      "would keep a settled scene reporting unready",
  );

  // The key the request computed, taken from the descriptor the request itself
  // built and stored, not re-derived here.
  const requestedKeys = [...renderer._pipelineCache.values()].map((entry) =>
    cache.describeCacheKey(entry.descriptor),
  );
  assert.equal(
    requestedKeys.length,
    namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.length,
    "each request must have left exactly one renderer-local entry",
  );
  for (const key of requestedKeys) {
    assert.ok(
      warmedKeys.has(key),
      `a requested descriptor's cache key is not one of the warmed keys: ${key}`,
    );
  }

  assert.equal(
    cache.getStats().wrongModuleHits,
    0,
    "a served hit must carry the modules the requester asked for",
  );
});

// ─────────────── E2: the negative control — the removed shape ───────────────

test("E2 a warm at context init serves nothing", async () => {
  const namespace = await importPrewarmGraph();
  const { context, renderer, sceneRenderer } = boot(namespace);
  const cache = context.webgpuPipelineCache;
  const sceneSamples = sceneMsaaSamplesDefault();

  // The removed shape: warm while the context still holds its own default,
  // because no scene has spoken yet.
  const offered = namespace.warmUpGlobePipelines(context, makeScene(1));
  assert.equal(
    offered,
    namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.length,
    "vacuity check: the init-time warm must actually offer every variant, or " +
      "this control proves nothing",
  );
  await settle(cache, namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.length, "E2");
  for (const row of cache.listPipelineVariants()) {
    assert.match(
      row.key,
      /samples=1\b/,
      `an init-time warm keys at the context default — got ${row.key}`,
    );
  }

  // The first frame arrives and writes the scene's request. The scene carries
  // no globe, so the in-frame warm declines — exactly as it does for a viewer
  // built with `globe: false` — and this control measures the init warm alone.
  sceneRenderer.prepareFrame({
    scene: makeScene(sceneSamples, false),
    context,
    useHDR: false,
  });
  assert.equal(context._msaaSamples, sceneSamples);
  await drain();
  assert.equal(
    cache.getStats().created,
    namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.length,
    "the globe-less frame must not have warmed anything further",
  );

  adoptSceneTargetAsATileWould(
    namespace,
    renderer,
    context,
    makeScene(sceneSamples).frameState,
    undefined,
  );
  const { served, hitDelta } = requestFirstFrameVariants(
    namespace,
    renderer,
    cache,
  );
  assert.deepEqual(
    served.map(([label, hit]) => [label, hit]),
    namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.map((variant) => [
      variant.label,
      false,
    ]),
    "an init-time warm must serve NOTHING — this is the defect the acceptance " +
      "condition exists to catch, and a spec that cannot see it here is not " +
      "evidence for E1",
  );
  assert.equal(hitDelta, 0, "an init-time warm must produce zero cache hits");
});

// ───────────────────────── E3: inertness mutant ─────────────────────────────

test("E3 mutant: the seam must be live, not merely present", async () => {
  const namespace = await importPrewarmGraph([
    {
      basename: "WebGPUSceneRenderer.ts",
      label: "prewarm-seam-unreachable",
      mutate: (source) =>
        source.replace(
          "    this._warmGlobePipelines(scene, context);",
          "    if (false && scene !== undefined) {\n      this._warmGlobePipelines(scene, context);\n    }",
        ),
    },
  ]);
  const { context, renderer, sceneRenderer } = boot(namespace);
  const cache = context.webgpuPipelineCache;
  const sceneSamples = sceneMsaaSamplesDefault();
  const scene = makeScene(sceneSamples);

  sceneRenderer.prepareFrame({ scene, context, useHDR: false });
  assert.equal(
    context._msaaSamples,
    sceneSamples,
    "the mutation must leave the rest of prepareFrame intact",
  );
  await drain();
  assert.equal(
    cache.getStats().created,
    0,
    "vacuity check: with the seam unreachable nothing may be warmed",
  );

  adoptSceneTargetAsATileWould(
    namespace,
    renderer,
    context,
    scene.frameState,
    undefined,
  );
  const { served, hitDelta } = requestFirstFrameVariants(
    namespace,
    renderer,
    cache,
  );
  assert.equal(
    served.filter(([, hit]) => hit).length,
    0,
    "with the seam unreachable every request must miss",
  );
  assert.equal(hitDelta, 0, "an unreachable seam must produce zero hits");
});

// ──────────────── E4: the key reads the requested sample count ──────────────

test("E4 mutant: a request at a different sample count misses", async () => {
  const namespace = await importPrewarmGraph();
  const { context, renderer, sceneRenderer } = boot(namespace);
  const cache = context.webgpuPipelineCache;
  const sceneSamples = sceneMsaaSamplesDefault();
  const scene = makeScene(sceneSamples);

  sceneRenderer.prepareFrame({ scene, context, useHDR: false });
  await settle(cache, namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.length, "E4");

  // Everything as E1, except the one number: the request side asks at the
  // context's init default instead of the count the frame settled on.
  adoptSceneTargetAsATileWould(
    namespace,
    renderer,
    context,
    scene.frameState,
    1,
  );
  assert.notEqual(
    renderer._sampleCount,
    context._msaaSamples,
    "vacuity check: the mutant must actually change the requested count",
  );
  const { served, hitDelta } = requestFirstFrameVariants(
    namespace,
    renderer,
    cache,
  );
  assert.equal(
    served.filter(([, hit]) => hit).length,
    0,
    "the cache key must carry the sample count: a request at a different " +
      "count must not be served the warmed pipeline",
  );
  assert.equal(hitDelta, 0, "a differing sample count must produce zero hits");
});

// ──────── E5: the prewarm list and the mirrored adoption are current ────────

test("E5 the warmed variants are the ones the terrain paths encode", async () => {
  const namespace = await importPrewarmGraph();
  const { default: TerrainEncoding } = await bundle({
    path: TERRAIN_ENCODING_PATH,
    source: TERRAIN_ENCODING_SOURCE,
    real: [],
    realDir: engineCore,
  });
  const center = { x: 0, y: 0, z: 0 };

  // `TerrainFillMesh` builds this encoding directly for the fills it makes from
  // level 4 down: no bounding box, so quantization falls back to NONE, with
  // vertex normals and Web-Mercator T both on.
  assert.ok(
    TERRAIN_FILL_MESH_SOURCE.includes(
      "    const encoding = new TerrainEncoding(\n" +
        "      center,\n" +
        "      undefined,\n" +
        "      undefined,\n" +
        "      undefined,\n" +
        "      undefined,\n" +
        "      true,\n" +
        "      true,\n" +
        "      hasGeodeticSurfaceNormals,",
    ),
    "TerrainFillMesh no longer builds its fill encoding with vertex normals " +
      "and Web-Mercator T and no bounding box — the 32-byte prewarm entry is " +
      "derived from that call and must be re-derived",
  );
  const fill = new TerrainEncoding(
    center,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    true,
    false,
    1.0,
    0.0,
  );

  // The constant-height heightmap `TerrainFillMesh` uses at levels 1 through 3,
  // and everything `EllipsoidTerrainProvider` produces: Web-Mercator T is
  // unconditional, and a heightmap never carries vertex normals.
  assert.ok(
    HEIGHTMAP_TERRAIN_DATA_SOURCE.includes("includeWebMercatorT: true"),
    "HeightmapTerrainData no longer requests the Web-Mercator texture " +
      "coordinate unconditionally — the 28-byte prewarm entry rests on it",
  );
  const coarseExtentMetres = 2.5e6;
  const heightmap = new TerrainEncoding(
    center,
    {
      minimum: { x: 0, y: 0, z: 0 },
      maximum: { x: coarseExtentMetres, y: coarseExtentMetres, z: 1.0e3 },
    },
    0,
    0,
    { __kind: "fromENU" },
    false,
    true,
    false,
    1.0,
    0.0,
  );
  assert.equal(
    heightmap.quantization,
    0,
    "a coarse tile must encode unquantized, or the first frames are not the " +
      "unquantized case this prewarm list covers",
  );

  // A tile small enough to quantize, so the assertion above is a statement
  // about extent rather than about quantization being unreachable.
  const deep = new TerrainEncoding(
    center,
    {
      minimum: { x: 0, y: 0, z: 0 },
      maximum: { x: 3.0e3, y: 3.0e3, z: 3.0e2 },
    },
    0,
    100,
    { __kind: "fromENU" },
    true,
    true,
    false,
    1.0,
    0.0,
  );
  assert.notEqual(
    deep.quantization,
    heightmap.quantization,
    "quantization must still be reachable for a small tile, or the coarse " +
      "assertion above is vacuous",
  );

  const measured = [
    {
      isQuantized: heightmap.quantization !== 0,
      hasNormals: heightmap.hasVertexNormals,
      hasWebMercatorT: heightmap.hasWebMercatorT,
      strideBytes: heightmap.stride * 4,
    },
    {
      isQuantized: fill.quantization !== 0,
      hasNormals: fill.hasVertexNormals,
      hasWebMercatorT: fill.hasWebMercatorT,
      strideBytes: fill.stride * 4,
    },
  ];
  assert.deepEqual(
    namespace.DEFAULT_GLOBE_PIPELINE_PREWARM.map((variant) => ({
      isQuantized: variant.isQuantized,
      hasNormals: variant.hasNormals,
      hasWebMercatorT: variant.hasWebMercatorT,
      strideBytes: variant.strideBytes,
    })),
    measured,
    "the prewarm list must match what the real TerrainEncoding produces for " +
      "the meshes a globe draws first",
  );
});

test("E5b the mirrored first-frame adoption still matches the renderer", () => {
  // `adoptSceneTargetAsATileWould` mirrors what `createTileCommands` does on
  // its first frame. Pin each line against the real source, windowed on the
  // block it lives in, so a drift fails here rather than silently making the
  // request side fictional.
  const branch = GLOBE_RENDERER_SOURCE.indexOf(
    "if (this._scenePipelineFormatGeneration !== ctxGen) {",
  );
  assert.ok(branch > 0, "the scene-format generation branch has moved");
  const window = GLOBE_RENDERER_SOURCE.slice(branch, branch + 1800);
  for (const anchor of [
    "this._canvasFormat = newFormat;",
    "._msaaSamples ?? 1;",
    "this._pipelineCache.clear();",
  ]) {
    assert.ok(
      window.includes(anchor),
      `the first-frame adoption no longer contains \`${anchor}\`; the mirror ` +
        `in this spec is stale`,
    );
  }

  // The lazy central-cache capture sits above the generation branch, so it
  // gets its own window.
  const capture = GLOBE_RENDERER_SOURCE.indexOf(
    "// Capture the central pipeline cache from the context.",
  );
  assert.ok(capture > 0, "the central-cache capture comment has moved");
  assert.match(
    GLOBE_RENDERER_SOURCE.slice(capture, capture + 900),
    /if \(!this\._centralPipelineCache\) \{[\s\S]*this\._centralPipelineCache =/,
    "createTileCommands no longer captures the central pipeline cache from " +
      "the context under an if-absent guard; the mirror in this spec is stale",
  );

  assert.match(
    GLOBE_RENDERER_SOURCE,
    /this\._logDepthEnabled = isWebGPULogDepthActive\(\s*frameState\.context,\s*frameState,\s*\);/,
    "the renderer no longer resolves log depth through the shared gate each " +
      "frame; the mirror in this spec is stale",
  );
});
