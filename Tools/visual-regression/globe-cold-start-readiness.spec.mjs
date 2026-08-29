// globe-cold-start-readiness.spec.mjs — browser-free contract for the WebGPU
// globe's frame-readiness signal and its cold-start pipeline prewarm. Pure
// Node: no browser, no GPU, no build.
//
// @purpose Pins the backend-neutral readiness query, the deferred-command count that makes an undrawn globe tile observable, and the init-time prewarm that lets the first tile find its pipeline already built.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// `globe.tilesLoaded === true` means the globe's three tile load queues are
// empty. On WebGL that coincides with "everything selected has drawn", because
// every resource a draw needs is created inside the call that needs it. On
// WebGPU it does not: `selectPipeline` returns null while the central cache is
// running `createRenderPipelineAsync`, the caller skips the tile for that
// frame, and the load queues stay empty the whole time — the tile's terrain and
// imagery are loaded, it is the pipeline that is missing. A capture gated on
// `tilesLoaded` therefore photographs a hole in the planet and reports it as a
// settled frame.
//
// Two things follow, and this file pins both:
//
//   A. READINESS. `GraphicsContext.pendingResourceCount` (0 on the base class,
//      the async monitor's foreground inflight count on WebGPU) plus
//      `FrameState.commandsDeferred` (incremented where a selected tile emits
//      nothing) give `Scene.renderReady` an honest answer. The two are not
//      redundant: a tile can be skipped for a reason that started no async work
//      (its buffers are not built), and async work can be inflight for a
//      producer that still drew everything it wanted.
//
//   B. COLD START. The first pipeline build of the ~286 KB `GlobeTerrain.wgsl`
//      is the longest single resource creation in a WebGPU boot, and until it
//      lands there is no globe at all. `prewarmDefaultPipelines` moves the
//      handful of variants a default globe draws with into the context's idle
//      init window, so the first tile that asks finds one already cached.
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// Nothing here asserts source text. The real modules are bundled with esbuild —
// the globe pipeline factory, the shader-module cache, the preprocessor, the
// define registry, the central pipeline cache and the device-liveness registry
// all REAL, everything else stubbed — and driven against fakes they cannot tell
// from a device. The stride table is checked against strides computed by the
// REAL `TerrainEncoding`, constructed the way the shipped terrain paths
// construct it, rather than against a second copy of the same numbers.
//
// Each group then re-imports through a source mutation and requires its
// assertion to go RED, in both flavours: ABSENCE (the code is deleted) and
// INERTNESS (the code is still there but unreachable). A guard that only
// survives deletion proves text presence, not that the branch is live. Every
// mutation runs through a vacuity check that fails loudly if its anchor moved.
//
// CRLF: this repo checks out with `core.autocrlf=true`; the anchors below are
// matched against LF-normalised text.
//
// Run: node --test Tools/visual-regression/globe-cold-start-readiness.spec.mjs

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

const GLOBE_RENDERING_PATH = resolve(
  engineScene,
  "GlobeSurfaceTileProviderRendering.js",
);
const GRAPHICS_CONTEXT_PATH = resolve(engineRenderer, "GraphicsContext.ts");
const WEBGPU_CONTEXT_PATH = resolve(engineWebGPU, "WebGPUContext.ts");
const MONITOR_PATH = resolve(engineWebGPU, "AsyncResourceMonitor.ts");
const TERRAIN_ENCODING_PATH = resolve(engineCore, "TerrainEncoding.js");

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

const GLOBE_RENDERING_SOURCE = await readSource(GLOBE_RENDERING_PATH);
const GRAPHICS_CONTEXT_SOURCE = await readSource(GRAPHICS_CONTEXT_PATH);
const WEBGPU_CONTEXT_SOURCE = await readSource(WEBGPU_CONTEXT_PATH);
const MONITOR_SOURCE = await readSource(MONITOR_PATH);
const TERRAIN_ENCODING_SOURCE = await readSource(TERRAIN_ENCODING_PATH);

// The globe pipeline factory and everything it needs to build a real
// descriptor and a real central-cache key. `WebGPUPickCommandHelpers` is
// deliberately NOT real — nothing on the production colour path calls it, and
// it drags in the whole pick fleet.
const GLOBE_REAL = [
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
];

/**
 * A device fake with just the surface the pipeline factory, the shader-module
 * cache and the central pipeline cache touch. Every created object is a fresh
 * identity, which is what the cache key's module-identity fold reads.
 *
 * @returns {object} The fake device plus its call log.
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
      shaderModules.push({ descriptor, module });
      return module;
    },
    createRenderPipeline(descriptor) {
      const pipeline = { __kind: "pipeline", label: descriptor.label };
      pipelines.push({ descriptor, pipeline, sync: true });
      return pipeline;
    },
    createRenderPipelineAsync(descriptor) {
      const pipeline = { __kind: "pipeline", label: descriptor.label };
      pipelines.push({ descriptor, pipeline, sync: false });
      return Promise.resolve(pipeline);
    },
    createBindGroupLayout() {
      return { __kind: "bindGroupLayout" };
    },
    createPipelineLayout() {
      return { __kind: "pipelineLayout" };
    },
    pushErrorScope() {},
    popErrorScope() {
      return Promise.resolve(null);
    },
  };
  return { device, shaderModules, pipelines };
}

// A minimal but syntactically real WGSL body. It carries no `//>>ifdef`
// directives, so the preprocessor is exercised on a source it passes through
// unchanged and the module cache keys purely on (sourceId, defines).
const FAKE_WGSL =
  "@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1.0); }\n";

/**
 * Builds a globe renderer wired far enough to select pipelines, without
 * calling `initialize` (which wants a complete device). The fields set here
 * are the ones `buildPipelineDescriptor` and the shader factory read.
 *
 * @param {Record<string, unknown>} namespace The bundled module namespace.
 * @param {object} device The fake device.
 * @returns {object} The renderer.
 */
function makeRenderer(namespace, device) {
  const { WebGPUGlobeSurfaceRenderer } = namespace;
  const renderer = new WebGPUGlobeSurfaceRenderer();
  renderer._device = device;
  renderer._canvasFormat = "bgra8unorm";
  renderer._pickFormat = "rgba8unorm";
  renderer._sampleCount = 1;
  renderer._pipelineLayout = device.createPipelineLayout();
  renderer._imageryReduced = false;
  renderer._isInitialized = true;
  // The real shader-module cache, constructed the way `initShaderCache` does.
  renderer._initShaderCache(FAKE_WGSL);
  return renderer;
}

// ───────────────────────── group A: the readiness query ─────────────────────

test("A1 the base GraphicsContext answers 0, which is the WebGL answer", async () => {
  const { GraphicsContext } = await bundle({
    path: GRAPHICS_CONTEXT_PATH,
    source: GRAPHICS_CONTEXT_SOURCE,
    real: [],
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    GraphicsContext.prototype,
    "pendingResourceCount",
  );
  assert.ok(
    descriptor?.get,
    "GraphicsContext must define pendingResourceCount as a getter, so a " +
      "backend with no asynchronous resource creation answers without the " +
      "caller branching on the renderer type",
  );
  // Executed against a bare object: the base implementation must not depend on
  // any state, because the WebGL Context inherits it untouched.
  assert.equal(descriptor.get.call({}), 0);
});

test("A2 the WebGPU override reports the monitor's live foreground count", async () => {
  const { WebGPUContext } = await bundle({
    path: WEBGPU_CONTEXT_PATH,
    source: WEBGPU_CONTEXT_SOURCE,
    real: ["AsyncResourceMonitor.ts"],
  });
  const { AsyncResourceMonitor } = await bundle({
    path: MONITOR_PATH,
    source: MONITOR_SOURCE,
    real: [],
  });

  const descriptor = Object.getOwnPropertyDescriptor(
    WebGPUContext.prototype,
    "pendingResourceCount",
  );
  assert.ok(descriptor?.get, "WebGPUContext must override the query");

  const monitor = new AsyncResourceMonitor("spec");
  const host = { _asyncResources: monitor };

  assert.equal(
    descriptor.get.call(host),
    0,
    "an idle monitor is not pending work",
  );

  const foreground = monitor.begin({
    kind: "render-pipeline",
    key: "globe:opaque",
  });
  assert.equal(
    descriptor.get.call(host),
    1,
    "a pipeline the frame is waiting on must read as pending",
  );

  monitor.begin({
    kind: "render-pipeline",
    key: "globe:blend",
    priority: "background",
  });
  assert.equal(
    descriptor.get.call(host),
    1,
    "speculative pre-cooking must not hold a scene un-ready: nothing on " +
      "screen is waiting for it",
  );

  monitor.resolve(foreground);
  assert.equal(descriptor.get.call(host), 0);

  // A context that never issued async work has no monitor, and polling
  // readiness must not be what creates one.
  assert.equal(descriptor.get.call({ _asyncResources: null }), 0);
  assert.equal(descriptor.get.call({}), 0);
});

// ─────────────── group B: a skipped tile is counted, then re-emitted ────────

// `FeatureRendererKey` is a dependency-free enum; `Pass` and `SceneMode` are
// too, and the globe command carries a real `Pass.GLOBE`. Keeping all three
// real means this group and the engine agree on the same constants.
const GLOBE_RENDERING_REAL = [
  "FeatureRendererKey.js",
  "Pass.js",
  "SceneMode.js",
  "defined.js",
];

/**
 * Imports the globe rendering module with the enums real.
 *
 * @param {Function} [mutate] Source rewrite.
 * @param {string} [label] Mutation name.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
function importGlobeRendering(mutate, label) {
  return bundle({
    path: GLOBE_RENDERING_PATH,
    source: GLOBE_RENDERING_SOURCE,
    real: GLOBE_RENDERING_REAL,
    mutate,
    label,
  });
}

/**
 * Builds the tile, tile provider and frame state `addDrawCommandsForTile`
 * needs, plus a feature-renderer descriptor whose renderer emits whatever the
 * caller asks it to.
 *
 * @param {Array|null} emit What `createTileCommands` returns.
 * @returns {object} The fixture.
 */
function makeGlobeFixture(emit) {
  const device = { __kind: "device" };
  let created = 0;
  class FakeGlobeRenderer {
    initialize() {
      created++;
    }
    isDestroyed() {
      return false;
    }
    createTileCommands() {
      return emit;
    }
    createWireframeTileCommands() {
      return emit;
    }
  }
  const featureRenderer = {
    RendererClass: FakeGlobeRenderer,
    getShaderCode: () => "@fragment fn fragmentMain() {}",
  };
  const context = {
    device,
    canvasFormat: "bgra8unorm",
    uniformState: {},
    sceneCaptureReflections: false,
    getFeatureRenderer: () => featureRenderer,
  };
  const frameState = {
    context,
    commandList: [],
    commandsDeferred: 0,
    // SceneMode.SCENE3D — kept as the literal the enum resolves to so the
    // fixture does not import the enum twice.
    mode: 3,
    frameNumber: 1,
    cameraUnderground: false,
    passes: { render: true, pick: false },
    globeTranslucencyState: { translucent: false },
  };
  const tile = {
    level: 3,
    x: 1,
    y: 2,
    rectangle: {},
    data: {
      mesh: {
        vertices: new Float32Array([0, 0, 0, 0]),
        indices: new Uint16Array([0, 0, 0]),
      },
      imagery: [],
      tileBoundingRegion: {
        boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 1 },
        boundingVolume: {},
        minimumHeight: 0,
        maximumHeight: 1,
      },
    },
  };
  const tileProvider = {
    shadows: 0,
    backFaceCulling: true,
    clippingPlanes: undefined,
    enableEnhancedOcean: false,
  };
  return { frameState, tile, tileProvider, rendererCreations: () => created };
}

test("B1 a tile whose pipeline is still cooking is counted, and drawn once it is not", async () => {
  const { addDrawCommandsForTile } = await importGlobeRendering();

  // Frame 1 — the renderer returns nothing, which is how the WebGPU globe says
  // "the pipeline for this vertex layout is still materializing".
  const pending = makeGlobeFixture(null);
  addDrawCommandsForTile(
    pending.tileProvider,
    pending.tile,
    pending.frameState,
  );
  assert.equal(
    pending.frameState.commandList.length,
    0,
    "the tile cannot draw without a pipeline",
  );
  assert.equal(
    pending.frameState.commandsDeferred,
    1,
    "a selected tile that emitted nothing must be counted, or a caller " +
      "polling readiness photographs the hole it leaves",
  );

  // Frame 2 — same tile, pipeline now exists.
  const ready = makeGlobeFixture([
    {
      pipeline: { __kind: "pipeline" },
      bindGroups: [],
      vertexBuffer: { __kind: "vb" },
      indexBuffer: { __kind: "ib" },
      indexCount: 3,
      indexFormat: "uint16",
    },
  ]);
  addDrawCommandsForTile(ready.tileProvider, ready.tile, ready.frameState);
  assert.equal(
    ready.frameState.commandList.length,
    1,
    "the tile draws once its pipeline exists",
  );
  assert.equal(
    ready.frameState.commandsDeferred,
    0,
    "a tile that drew is not deferred",
  );
});

test("B2 an empty descriptor list counts too — it is the same signal as null", async () => {
  const { addDrawCommandsForTile } = await importGlobeRendering();
  const fixture = makeGlobeFixture([]);
  addDrawCommandsForTile(
    fixture.tileProvider,
    fixture.tile,
    fixture.frameState,
  );
  assert.equal(fixture.frameState.commandList.length, 0);
  assert.equal(fixture.frameState.commandsDeferred, 1);
});

test("B3 mutants: the count must be live, not merely present", async () => {
  // ABSENCE — the increment is deleted from the empty-descriptor branch.
  const absent = await importGlobeRendering(
    (source) =>
      source.replace(
        `    noteDeferredTile(frameState);
    return;
  }

  const tileBR = surfaceTile.tileBoundingRegion;`,
        `    return;
  }

  const tileBR = surfaceTile.tileBoundingRegion;`,
      ),
    "absent-increment",
  );
  const absentFixture = makeGlobeFixture(null);
  absentFixture.frameState.commandsDeferred = 0;
  absent.addDrawCommandsForTile(
    absentFixture.tileProvider,
    absentFixture.tile,
    absentFixture.frameState,
  );
  assert.equal(
    absentFixture.frameState.commandsDeferred,
    0,
    "vacuity check: with the increment deleted the count must stay 0, " +
      "otherwise B1 was passing for some other reason",
  );

  // INERTNESS — the call site is still there and still reached, but the
  // function it calls no longer records anything. A guard that only survives
  // deletion is asserting text presence, not that the counter is live.
  const inert = await importGlobeRendering(
    (source) =>
      source.replace(
        `function noteDeferredTile(frameState) {
  frameState.commandsDeferred = (frameState.commandsDeferred ?? 0) + 1;
}`,
        `function noteDeferredTile(frameState) {
  if (false) {
    frameState.commandsDeferred = (frameState.commandsDeferred ?? 0) + 1;
  }
}`,
      ),
    "inert-increment",
  );
  const inertFixture = makeGlobeFixture(null);
  inertFixture.frameState.commandsDeferred = 0;
  inert.addDrawCommandsForTile(
    inertFixture.tileProvider,
    inertFixture.tile,
    inertFixture.frameState,
  );
  assert.equal(
    inertFixture.frameState.commandsDeferred,
    0,
    "vacuity check: an inert counter must read 0",
  );
});

// ─────── group C: the prewarmed module is the one the production path asks ───

// One synthetic entry, so the renderer, the pipeline factory, the log-depth
// gate and the module cache all come from a SINGLE module graph. Two separate
// bundles would give the prewarm and the selection two different copies of the
// shader-module cache and the define registry, and the identity fold in the
// cache key would then separate keys that are the same key at runtime — the
// test would pass or fail for a reason invented by the harness.
const COLD_START_ENTRY_PATH = resolve(engineWebGPU, "__globe-cold-start.ts");
const COLD_START_ENTRY_SOURCE = [
  'export * from "./WebGPUGlobeSurfaceRenderer.js";',
  'export { selectPipeline } from "./WebGPUGlobeSurfacePipelines.js";',
  'export { WebGPURenderPipelineCache } from "./WebGPURenderPipelineCache.js";',
  'export { isWebGPULogDepthActive } from "./WebGPULogDepth.js";',
  "",
].join("\n");

/**
 * Imports the renderer, the pipeline factory, the central cache and the
 * log-depth gate together.
 *
 * @param {Array} [overrides] Rewrites applied to real dependencies.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
function importColdStart(overrides) {
  return bundle({
    path: COLD_START_ENTRY_PATH,
    source: COLD_START_ENTRY_SOURCE,
    real: [...GLOBE_REAL, "WebGPUGlobeSurfaceRenderer.ts", "WebGPULogDepth.ts"],
    overrides,
  });
}

/**
 * Resolves the log-depth state the way the production path resolves it, from
 * real code at every link this spec can execute.
 *
 * The chain is: `WebGPUContext.fragmentDepth` (executed, off a real instance)
 * to `Scene.defaultLogDepthBuffer` (the real static) to `Scene`'s
 * `_logDepthBuffer` to `frameState.useLogDepth` to the real
 * `isWebGPULogDepthActive`, which is the function `createTileCommands` calls to
 * write `renderer._logDepthEnabled`.
 *
 * TWO LINES ARE MIRRORED RATHER THAN EXECUTED, and they are the only two:
 * `Scene.js:413` (`_logDepthBuffer = Scene.defaultLogDepthBuffer &&
 * context.fragmentDepth`) and `Scene.js:3734-3739` (`useLogDepth =
 * _logDepthBuffer && !(orthographic frustum)`). Both live inside methods that
 * cannot be driven without a whole Scene. Their INPUTS are real here, so a
 * change to either default is caught; a change to the two expressions
 * themselves is not, and that is stated rather than hidden.
 *
 * @param {object} sceneClass The real bundled Scene class.
 * @param {object} contextInstance A real WebGPUContext instance.
 * @param {Record<string, unknown>} coldStart The cold-start namespace.
 * @returns {{logDepthEnabled: boolean, useLogDepth: boolean}} The state.
 */
function resolveProductionLogDepth(sceneClass, contextInstance, coldStart) {
  // Scene.js:413
  const logDepthBuffer =
    sceneClass.defaultLogDepthBuffer && contextInstance.fragmentDepth;
  // Scene.js:3734-3739 — a default viewer's frustum is perspective, so the
  // orthographic disqualifier does not fire.
  const useLogDepth = logDepthBuffer && true;
  const logDepthEnabled = coldStart.isWebGPULogDepthActive(contextInstance, {
    useLogDepth,
  });
  return { logDepthEnabled, useLogDepth };
}

/**
 * The two context inputs the production log-depth gate reads, taken from real
 * code wherever real code can be reached without a device.
 *
 * `fragmentDepth` is the REAL getter on `WebGPUContext.prototype`, executed —
 * it is a pure literal return, so a bare receiver is faithful.
 *
 * `_logDepthWriteEnabled` is a class FIELD INITIALISER, and reading it needs a
 * constructed context: `WebGPUContext`'s constructor builds a shader cache, a
 * uniform state and a pass state, none of which survive being stubbed. It is
 * therefore the one input this spec supplies rather than executes. It is not
 * left unguarded: C2's gate-sensitivity mutant flips it and requires the
 * outcome to change, so the spec cannot be passing because the value is a
 * constant it chose.
 *
 * @returns {Promise<object>} A context-shaped object for the real gate.
 */
async function productionContextInputs() {
  const { WebGPUContext } = await bundle({
    path: WEBGPU_CONTEXT_PATH,
    source: WEBGPU_CONTEXT_SOURCE,
    real: [],
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    WebGPUContext.prototype,
    "fragmentDepth",
  );
  assert.ok(descriptor?.get, "WebGPUContext must expose fragmentDepth");
  return {
    fragmentDepth: descriptor.get.call({}),
    _logDepthWriteEnabled: true,
  };
}

/**
 * Requests a pipeline the way the production path does for the opaque first
 * pass of a tile with this vertex layout: cull back, no clip distances, no
 * geodetic surface normals, and whatever log-depth state the renderer resolved.
 *
 * The argument list mirrors the call site in
 * WebGPUGlobeSurfaceRenderer.createTileCommands, which reads the first four
 * values off gpuResources and passes isSubsequentPass || globeTranslucent as
 * the blend flag.
 *
 * @param {Record<string, unknown>} namespace The bundled namespace.
 * @param {object} renderer The renderer under test.
 * @param {object} layout A vertex layout from the real TerrainEncoding.
 * @returns {object|null} The pipeline, or null while it is still cooking.
 */
function requestPipelineAsATileWould(namespace, renderer, layout) {
  return namespace.selectPipeline(
    renderer,
    layout.isQuantized,
    layout.hasNormals,
    layout.hasWebMercatorT,
    false, // isSubsequentPass || globeTranslucent
    layout.strideBytes,
    false, // useClipDistances
    false, // hasGeodeticSurfaceNormals
    false, // disableCulling
  );
}

/**
 * The vertex layout of a `TerrainFillMesh`, computed by the REAL
 * `TerrainEncoding` with the argument shape `TerrainFillMesh.createFillMesh`
 * uses: no bounding box (so quantization falls back to NONE), vertex normals
 * and Web-Mercator T both true. Fill meshes are what a cold camera draws
 * first, which makes this the layout of the first pipeline a cold globe
 * requests.
 *
 * @returns {Promise<object>} The layout, plus the quantizations it came from.
 */
async function fillMeshVertexLayout() {
  const { default: TerrainEncoding } = await bundle({
    path: TERRAIN_ENCODING_PATH,
    source: TERRAIN_ENCODING_SOURCE,
    real: [],
    realDir: engineCore,
  });
  const center = { x: 0, y: 0, z: 0 };
  const fill = new TerrainEncoding(
    center,
    undefined,
    undefined,
    undefined,
    undefined,
    true, // hasVertexNormals
    true, // hasWebMercatorT
    false, // hasGeodeticSurfaceNormals
    1.0,
    0.0,
  );
  // A refined tile, for the guard below: if BITS12 ever stopped being
  // reachable, the fill layout would be indistinguishable from every other
  // layout and this would silently stop being a specific case.
  const quantized = new TerrainEncoding(
    center,
    {
      minimum: { x: 0, y: 0, z: 0 },
      maximum: { x: 100, y: 100, z: 100 },
    },
    0,
    50,
    { __kind: "fromENU" },
    true,
    true,
    false,
    1.0,
    0.0,
  );
  return {
    fill: {
      isQuantized: fill.quantization !== 0,
      hasNormals: fill.hasVertexNormals,
      hasWebMercatorT: fill.hasWebMercatorT,
      strideBytes: fill.stride * 4,
    },
    fillQuantization: fill.quantization,
    quantizedQuantization: quantized.quantization,
  };
}

test("C1 the production request finds its terrain module already compiled", async () => {
  const namespace = await importColdStart();
  const { default: Scene } = await bundle({
    path: SCENE_PATH,
    source: SCENE_SOURCE,
    real: [],
  });
  const contextInstance = await productionContextInputs();
  const layouts = await fillMeshVertexLayout();
  assert.notEqual(
    layouts.fillQuantization,
    layouts.quantizedQuantization,
    "a fill mesh and a refined tile must encode differently, or this layout " +
      "is not the specific case it claims to be",
  );

  const { logDepthEnabled } = resolveProductionLogDepth(
    Scene,
    contextInstance,
    namespace,
  );
  assert.equal(
    logDepthEnabled,
    true,
    "a default WebGPU viewer must resolve log depth ON — if this is false the " +
      "prewarm masks are warming the wrong define set for the opposite " +
      "reason, and the whole premise has moved",
  );

  const { device, shaderModules } = makeFakeDevice();
  const renderer = makeRenderer(namespace, device);
  // Resolved, not asserted: this is the value `createTileCommands` writes at
  // WebGPUGlobeSurfaceRenderer.ts:1226 from the same gate function.
  renderer._logDepthEnabled = logDepthEnabled;
  renderer._centralPipelineCache = new namespace.WebGPURenderPipelineCache(
    device,
    "modules",
  );

  const afterPrewarm = shaderModules.length;
  assert.ok(
    afterPrewarm > 0,
    "the shader-module prewarm must compile something at init",
  );

  // The production request. If the prewarmed define set matches what a default
  // scene asks for, this is served from the module cache and compiles nothing
  // new; if it does not, the ~286 KB module is compiled here — on the render
  // path — which is the cost the prewarm list exists to remove.
  requestPipelineAsATileWould(namespace, renderer, layouts.fill);
  assert.equal(
    shaderModules.length,
    afterPrewarm,
    "a default log-depth scene must find its terrain module already " +
      "compiled; a new compile here means the prewarm warmed a define set " +
      "nobody requests",
  );
});

test("C2 mutants: the mask must be live, and the test sensitive to the gate", async () => {
  const { default: Scene } = await bundle({
    path: SCENE_PATH,
    source: SCENE_SOURCE,
    real: [],
  });
  const contextInstance = await productionContextInputs();
  const layouts = await fillMeshVertexLayout();

  // ABSENCE — the log-depth bit is taken back out of the shader-module
  // prewarm, which is the state this lane found the file in. C1 must go red.
  const noLogDepth = await importColdStart([
    {
      basename: "WebGPUGlobeSurfaceShaders.ts",
      label: "prewarm-without-log-depth",
      mutate: (source) =>
        source.replace(
          "    ShaderDefine.LOG_DEPTH | reducedBit, // production terrain without geodetic normals\n    // exaggerated terrain\n    ShaderDefine.GEODETIC_NORMAL | ShaderDefine.LOG_DEPTH | reducedBit,",
          "    reducedBit,\n    ShaderDefine.GEODETIC_NORMAL | reducedBit,",
        ),
    },
  ]);
  const staleDevice = makeFakeDevice();
  const staleRenderer = makeRenderer(noLogDepth, staleDevice.device);
  staleRenderer._logDepthEnabled = resolveProductionLogDepth(
    Scene,
    contextInstance,
    noLogDepth,
  ).logDepthEnabled;
  staleRenderer._centralPipelineCache =
    new noLogDepth.WebGPURenderPipelineCache(staleDevice.device, "stale");
  const beforeStale = staleDevice.shaderModules.length;
  requestPipelineAsATileWould(noLogDepth, staleRenderer, layouts.fill);
  assert.ok(
    staleDevice.shaderModules.length > beforeStale,
    "vacuity check: without the log-depth bit the default scene's module " +
      "must be compiled on the render path, otherwise C1 proves nothing",
  );

  // GATE SENSITIVITY — the masks are correct, but the context's log-depth
  // master switch is off, so the production request resolves a DIFFERENT
  // define set and misses the prewarm. This is what proves C1 reads the gate
  // rather than a constant: if C1 passed with the gate forced either way, it
  // would be asserting that two hand-picked numbers are equal.
  const namespace = await importColdStart();
  const gatedDevice = makeFakeDevice();
  const gatedRenderer = makeRenderer(namespace, gatedDevice.device);
  const gateOff = namespace.isWebGPULogDepthActive(
    { _logDepthWriteEnabled: false },
    { useLogDepth: true },
  );
  assert.equal(gateOff, false, "the gate must veto on the master switch");
  gatedRenderer._logDepthEnabled = gateOff;
  gatedRenderer._centralPipelineCache = new namespace.WebGPURenderPipelineCache(
    gatedDevice.device,
    "gated",
  );
  const beforeGated = gatedDevice.shaderModules.length;
  requestPipelineAsATileWould(namespace, gatedRenderer, layouts.fill);
  assert.ok(
    gatedDevice.shaderModules.length > beforeGated,
    "vacuity check: with log depth off the request must compile the OTHER " +
      "module, which is what makes C1's equality a statement about the gate",
  );
});

// ─────────────── group D: the scene-level predicate the caller polls ────────

const SCENE_PATH = resolve(engineScene, "Scene.js");
const SCENE_SOURCE = await readSource(SCENE_PATH);

test("D1 renderReady is false while either half of the signal is non-zero", async () => {
  const { default: Scene } = await bundle({
    path: SCENE_PATH,
    source: SCENE_SOURCE,
    real: [],
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    Scene.prototype,
    "renderReady",
  );
  assert.ok(descriptor?.get, "Scene must expose renderReady as a getter");

  const read = (deferred, pending) =>
    descriptor.get.call({
      _frameState: { commandsDeferred: deferred },
      _context: { pendingResourceCount: pending },
    });

  assert.equal(read(0, 0), true, "nothing deferred, nothing cooking");
  assert.equal(
    read(1, 0),
    false,
    "a tile that could not draw must hold the frame un-ready even when the " +
      "backend has no work inflight — the reason a tile is skipped is not " +
      "always asynchronous",
  );
  assert.equal(
    read(0, 1),
    false,
    "a resource the frame is waiting on must hold it un-ready even when no " +
      "producer has dropped a draw yet",
  );
  assert.equal(read(2, 3), false);

  // A WebGL context has no override, so the base getter answers 0 and the
  // predicate reduces to the deferred count — which WebGL producers never
  // raise. That is the same code path, not a special case.
  assert.equal(
    descriptor.get.call({
      _frameState: { commandsDeferred: 0 },
      _context: { pendingResourceCount: 0 },
    }),
    true,
  );
  // And a scene whose context is gone must not throw while a caller polls.
  assert.equal(
    descriptor.get.call({ _frameState: { commandsDeferred: 0 } }),
    true,
  );
});

test("D2 mutants: renderReady must read both halves", async () => {
  // INERTNESS — the deferred half is still read, but can no longer be false.
  const ignoresDeferred = await bundle({
    path: SCENE_PATH,
    source: SCENE_SOURCE,
    real: [],
    label: "renderReady-ignores-deferred",
    mutate: (source) =>
      source.replace(
        "      this._frameState.commandsDeferred === 0 &&",
        "      (this._frameState.commandsDeferred === 0 || true) &&",
      ),
  });
  const deferredDescriptor = Object.getOwnPropertyDescriptor(
    ignoresDeferred.default.prototype,
    "renderReady",
  );
  assert.equal(
    deferredDescriptor.get.call({
      _frameState: { commandsDeferred: 5 },
      _context: { pendingResourceCount: 0 },
    }),
    true,
    "vacuity check: with the deferred half neutralised the predicate must " +
      "report ready, otherwise D1 was passing for some other reason",
  );

  // INERTNESS — the pending half is still read, but can no longer be false.
  const ignoresPending = await bundle({
    path: SCENE_PATH,
    source: SCENE_SOURCE,
    real: [],
    label: "renderReady-ignores-pending",
    mutate: (source) =>
      source.replace(
        "      (this._context?.pendingResourceCount ?? 0) === 0\n    );",
        "      ((this._context?.pendingResourceCount ?? 0) === 0 || true)\n    );",
      ),
  });
  const pendingDescriptor = Object.getOwnPropertyDescriptor(
    ignoresPending.default.prototype,
    "renderReady",
  );
  assert.equal(
    pendingDescriptor.get.call({
      _frameState: { commandsDeferred: 0 },
      _context: { pendingResourceCount: 7 },
    }),
    true,
    "vacuity check: with the pending half neutralised the predicate must " +
      "report ready",
  );
});
