/**
 * Browser-free contract for the per-device WGSL compile census and for the
 * context option that lets a globe-less scene decline the init-time globe warm.
 *
 * Both exist to answer one question about a WebGPU cold start: how much shader
 * text was handed to the device, and how much of it the scene will never bind.
 * The residency instrument reads the census through
 * `GraphicsContext#getRendererStatistics`, so what the census counts has to be
 * a property of the shipped code rather than of the reader's expectation.
 *
 * WHAT IS REAL HERE. `WebGPUShaderModuleCache`, its preprocessor, the define
 * registry and `warmUpGlobeRenderer` all execute — they are bundled from
 * source through the engine stub bundler, with everything they do not need
 * replaced by proxies. The device is a fake, because a real one needs a GPU;
 * every assertion below is about what the engine asked the device to do, which
 * the fake records verbatim.
 *
 * WHAT IS ASSERTED IS BEHAVIOUR, NOT SHAPE. The census assertions are stated
 * against the fake device's own compile log — count and byte totals are
 * checked to agree with the modules the device actually received, not with a
 * literal copied from the counter. The warm assertions are stated against
 * whether a renderer was constructed and initialized at all.
 *
 * Run: node --test packages/engine/Specs/Renderer/WebGPU/WebGPUShaderModuleCensusSpec.mjs
 */
import assert from "node:assert/strict";
// Imported rather than taken from the global scope so the file lints under the
// engine Specs config, which targets the browser globals the Jasmine suite has.
import console from "node:console";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle } from "../../../../../Tools/visual-regression/lib/engine-stub-bundler.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(HERE, "../../../Source");
const ENGINE_WEBGPU = resolve(ENGINE_SOURCE, "Renderer/WebGPU");
const ENGINE_SCENE = resolve(ENGINE_SOURCE, "Scene");

// One synthetic entry, so the cache the warm compiles through and the census
// the assertions read come from a SINGLE module graph. Two bundles would give
// them two copies of the module-scoped `censusByDevice` WeakMap and the spec
// would then be reading a census nothing wrote to.
const ENTRY_PATH = resolve(ENGINE_WEBGPU, "__shader-module-census.ts");
const ENTRY_SOURCE = [
  "export {",
  "  WebGPUShaderModuleCache,",
  "  getWebGPUShaderModuleCensus,",
  '} from "./WebGPUShaderModuleCache.js";',
  'export { warmUpGlobeRenderer } from "../../Scene/GlobeSurfaceTileProviderRendering.js";',
  'export { default as FeatureRendererKey } from "../FeatureRendererKey.js";',
  "",
].join("\n");

const REAL = [
  "WebGPUShaderModuleCache.ts",
  "WebGPUShaderPreprocessor.ts",
  "WebGPUShaderDefines.ts",
  "GlobeSurfaceTileProviderRendering.js",
  "FeatureRendererKey.js",
  "defined.js",
];

// esbuild resolves in parallel, so a stub can be materialised before the file
// that imports the most from it has been read. Naming the big importer removes
// the ordering dependency rather than leaving it to luck.
const PRESEED = [resolve(ENGINE_SCENE, "GlobeSurfaceTileProviderRendering.js")];

// Two distinct WGSL bodies with no `//>>ifdef` directives, so the preprocessor
// passes them through unchanged and the compiled length is the source length.
// Different lengths are the point: a census that summed a constant would agree
// with a single-length fixture and disagree here.
const SMALL_WGSL =
  "@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1.0); }\n";
const LARGE_WGSL = `${SMALL_WGSL}// padding to make this body distinctly longer than the other one.\n`;

/**
 * Reads the shipped source once so every mutation below rewrites the same
 * bytes the engine ships rather than a paraphrase of them.
 *
 * @returns {Promise<Record<string, unknown>>} The bundled namespace.
 */
function load(options = {}) {
  return bundle({
    path: ENTRY_PATH,
    source: ENTRY_SOURCE,
    real: REAL,
    preseed: PRESEED,
    ...options,
  });
}

const NAMESPACE = await load();

/**
 * A device fake with the one method under test, recording every compile.
 *
 * Each call returns a fresh identity so a served cache hit is distinguishable
 * from a fresh compile without reading any counter.
 *
 * @returns {object} The fake device and its compile log.
 */
function makeFakeDevice() {
  const compiles = [];
  const device = {
    createShaderModule(descriptor) {
      const module = { id: compiles.length, label: descriptor.label };
      compiles.push({ code: descriptor.code, label: descriptor.label, module });
      return module;
    },
  };
  return { device, compiles };
}

/**
 * A context shaped the way `warmUpGlobeRenderer` reads one, with a feature
 * renderer whose `initialize` compiles through the REAL module cache.
 *
 * The renderer class is a local fake rather than the shipped globe renderer:
 * the warm's contract at this seam is "construct the registered class and call
 * its initialize", and driving the real globe renderer would replace that
 * contract with a test of the globe's own device setup.
 *
 * @param {object} input The device, the namespace and the option under test.
 * @returns {object} The context plus what the warm did to it.
 */
function makeWarmContext({ device, namespace, prewarmGlobeRendererEnabled }) {
  const constructed = [];
  const initialized = [];

  class FakeGlobeRenderer {
    constructor() {
      constructed.push(this);
      this._destroyed = false;
    }

    isDestroyed() {
      return this._destroyed;
    }

    initialize(initDevice, shaderCode) {
      initialized.push({ device: initDevice, shaderCode });
      // The warm's whole cost is this compile, so the spec routes it through
      // the real cache: that is what makes the census the measurement of the
      // warm rather than a number beside it.
      const cache = new namespace.WebGPUShaderModuleCache(initDevice);
      cache.getOrCreate(0, shaderCode, 0, "globe-terrain");
      cache.getOrCreate(1, LARGE_WGSL, 0, "globe-terrain-variant");
      this.isInitialized = true;
    }
  }

  const context = {
    device,
    canvasFormat: "bgra8unorm",
    getFeatureRenderer() {
      return {
        RendererClass: FakeGlobeRenderer,
        getShaderCode: () => SMALL_WGSL,
      };
    },
  };
  if (prewarmGlobeRendererEnabled !== undefined) {
    context.prewarmGlobeRendererEnabled = prewarmGlobeRendererEnabled;
  }
  return { context, constructed, initialized };
}

/**
 * Runs the warm with the prewarm log silenced, so the spec's own output stays
 * readable. The log is a debug pragma in the shipped source and is not what is
 * under test.
 *
 * @param {Record<string, unknown>} namespace The bundled namespace.
 * @param {object} context The warm's context.
 */
function warmQuietly(namespace, context) {
  const realLog = console.log;
  console.log = () => {};
  try {
    namespace.warmUpGlobeRenderer(context);
  } finally {
    console.log = realLog;
  }
}

// ── A. the census counts what the device was actually handed ────────────────

test("A1: a compile is counted once, with the length the device received", () => {
  const { device, compiles } = makeFakeDevice();
  const cache = new NAMESPACE.WebGPUShaderModuleCache(device);

  cache.getOrCreate(0, SMALL_WGSL, 0, "a");
  cache.getOrCreate(1, LARGE_WGSL, 0, "b");

  const census = NAMESPACE.getWebGPUShaderModuleCensus(device);
  const handed = compiles.reduce(
    (total, entry) => total + entry.code.length,
    0,
  );
  assert.equal(census.modulesCreated, compiles.length);
  assert.equal(census.wgslBytes, handed);
  assert.equal(
    census.largestWgslBytes,
    Math.max(...compiles.map((entry) => entry.code.length)),
  );
  assert.notEqual(
    SMALL_WGSL.length,
    LARGE_WGSL.length,
    "the fixture must use two different lengths or a summed total is " +
      "indistinguishable from a counted one times a constant",
  );
});

test("A2: a served lookup compiles nothing and moves only the hit counter", () => {
  const { device, compiles } = makeFakeDevice();
  const cache = new NAMESPACE.WebGPUShaderModuleCache(device);

  const first = cache.getOrCreate(0, SMALL_WGSL, 0, "a");
  const afterFirst = NAMESPACE.getWebGPUShaderModuleCensus(device);
  const second = cache.getOrCreate(0, SMALL_WGSL, 0, "a");
  const afterSecond = NAMESPACE.getWebGPUShaderModuleCensus(device);

  assert.equal(second, first, "the second lookup must be served, not compiled");
  assert.equal(compiles.length, 1);
  assert.equal(afterSecond.modulesCreated, afterFirst.modulesCreated);
  assert.equal(afterSecond.wgslBytes, afterFirst.wgslBytes);
  assert.equal(afterSecond.cacheHits, afterFirst.cacheHits + 1);
});

test("A3: caches sharing a device share one census; a second device has its own", () => {
  const { device: deviceA, compiles: compilesA } = makeFakeDevice();
  const { device: deviceB, compiles: compilesB } = makeFakeDevice();

  // Two cache instances on ONE device is the shipped arrangement: renderers
  // each hold their own instance behind their own per-device WeakMap, so a
  // per-instance total would answer for one renderer instead of the device.
  new NAMESPACE.WebGPUShaderModuleCache(deviceA).getOrCreate(
    0,
    SMALL_WGSL,
    0,
    "a",
  );
  new NAMESPACE.WebGPUShaderModuleCache(deviceA).getOrCreate(
    1,
    LARGE_WGSL,
    0,
    "b",
  );
  new NAMESPACE.WebGPUShaderModuleCache(deviceB).getOrCreate(
    0,
    SMALL_WGSL,
    0,
    "a",
  );

  const censusA = NAMESPACE.getWebGPUShaderModuleCensus(deviceA);
  const censusB = NAMESPACE.getWebGPUShaderModuleCensus(deviceB);
  assert.equal(censusA.modulesCreated, compilesA.length);
  assert.equal(censusA.modulesCreated, 2);
  assert.equal(censusB.modulesCreated, compilesB.length);
  assert.equal(censusB.modulesCreated, 1);
});

test("A4: an unmeasured device reads undefined, which is not a zeroed census", () => {
  const { device } = makeFakeDevice();
  assert.equal(NAMESPACE.getWebGPUShaderModuleCensus(device), undefined);
  assert.equal(NAMESPACE.getWebGPUShaderModuleCensus(null), undefined);
  assert.equal(NAMESPACE.getWebGPUShaderModuleCensus(undefined), undefined);

  // Constructing a cache is what registers the device, and registering it is
  // the whole behaviour under test here.
  const registered = new NAMESPACE.WebGPUShaderModuleCache(device);
  assert.equal(registered.size(), 0);
  const census = NAMESPACE.getWebGPUShaderModuleCensus(device);
  assert.deepEqual(census, {
    modulesCreated: 0,
    wgslBytes: 0,
    largestWgslBytes: 0,
    cacheHits: 0,
  });
});

test("A5: the returned census is a snapshot a caller cannot write through", () => {
  const { device } = makeFakeDevice();
  const cache = new NAMESPACE.WebGPUShaderModuleCache(device);
  cache.getOrCreate(0, SMALL_WGSL, 0, "a");

  const snapshot = NAMESPACE.getWebGPUShaderModuleCensus(device);
  snapshot.modulesCreated = 9999;
  assert.equal(
    NAMESPACE.getWebGPUShaderModuleCensus(device).modulesCreated,
    1,
    "a reader that edits its copy must not edit the running totals",
  );
});

test("A6: dropping cached modules keeps the compile history", () => {
  const { device } = makeFakeDevice();
  const cache = new NAMESPACE.WebGPUShaderModuleCache(device);
  cache.getOrCreate(0, SMALL_WGSL, 0, "a");
  const before = NAMESPACE.getWebGPUShaderModuleCensus(device);

  cache.destroy();

  assert.deepEqual(NAMESPACE.getWebGPUShaderModuleCensus(device), before);
});

// ── B. the globe warm can be declined, and declining it is opt-in ───────────

test("B1: a context that names no option is warmed exactly as before", () => {
  const { device } = makeFakeDevice();
  const { context, constructed, initialized } = makeWarmContext({
    device,
    namespace: NAMESPACE,
    prewarmGlobeRendererEnabled: undefined,
  });

  warmQuietly(NAMESPACE, context);

  assert.equal(constructed.length, 1);
  assert.equal(initialized.length, 1);
});

test("B2: a context that opts out is not warmed at all", () => {
  const { device, compiles } = makeFakeDevice();
  const { context, constructed, initialized } = makeWarmContext({
    device,
    namespace: NAMESPACE,
    prewarmGlobeRendererEnabled: false,
  });

  warmQuietly(NAMESPACE, context);

  assert.equal(constructed.length, 0);
  assert.equal(initialized.length, 0);
  assert.equal(compiles.length, 0, "declining the warm must compile nothing");
});

test("B3: an explicit true is warmed, so the opt-out is the only refusal", () => {
  const { device } = makeFakeDevice();
  const { context, constructed } = makeWarmContext({
    device,
    namespace: NAMESPACE,
    prewarmGlobeRendererEnabled: true,
  });

  warmQuietly(NAMESPACE, context);

  assert.equal(constructed.length, 1);
});

// ── C. the census answers the question the instrument asks of it ────────────

test("C1: the warm's WGSL appears in the census, and declining it removes exactly that", () => {
  const warmed = makeFakeDevice();
  const declined = makeFakeDevice();

  warmQuietly(
    NAMESPACE,
    makeWarmContext({ device: warmed.device, namespace: NAMESPACE }).context,
  );
  warmQuietly(
    NAMESPACE,
    makeWarmContext({
      device: declined.device,
      namespace: NAMESPACE,
      prewarmGlobeRendererEnabled: false,
    }).context,
  );

  const warmedCensus = NAMESPACE.getWebGPUShaderModuleCensus(warmed.device);
  const declinedCensus = NAMESPACE.getWebGPUShaderModuleCensus(declined.device);

  assert.equal(warmedCensus.modulesCreated, warmed.compiles.length);
  assert.equal(warmedCensus.modulesCreated, 2);
  assert.equal(
    warmedCensus.wgslBytes,
    SMALL_WGSL.length + LARGE_WGSL.length,
    "the census must carry the warm's whole shader text, not its module count",
  );
  assert.equal(
    declinedCensus,
    undefined,
    "a declined warm constructs no cache, so the device has no census at all",
  );
});

// ── D. inertness mutants ───────────────────────────────────────────────────
//
// Each mutant leaves the code present and running but makes the behaviour
// under test unreachable, then requires an assertion above to change its
// answer. `mutateOrFail` inside the bundler fails loudly when an anchor has
// moved, so a mutant cannot pass vacuously.

test("D1 MUTATION: an unreachable byte tally leaves the census blind to size", async () => {
  const mutated = await load({
    overrides: [
      {
        basename: "WebGPUShaderModuleCache.ts",
        label: "wgsl-byte-tally-inert",
        mutate: (source) =>
          source.replace(
            "    census.wgslBytes += processed.length;",
            "    if (false && processed.length) {\n" +
              "      census.wgslBytes += processed.length;\n" +
              "    }",
          ),
      },
    ],
  });

  const { device } = makeFakeDevice();
  const cache = new mutated.WebGPUShaderModuleCache(device);
  cache.getOrCreate(0, SMALL_WGSL, 0, "a");
  const census = mutated.getWebGPUShaderModuleCensus(device);

  assert.equal(
    census.modulesCreated,
    1,
    "the mutant must leave the count alone, so only the byte reading is under test",
  );
  assert.notEqual(
    census.wgslBytes,
    SMALL_WGSL.length,
    "A1 asserts this equality; with the tally unreachable it must not hold",
  );
});

test("D2 MUTATION: an unreachable prewarm guard warms a context that opted out", async () => {
  const mutated = await load({
    overrides: [
      {
        basename: "GlobeSurfaceTileProviderRendering.js",
        label: "prewarm-opt-out-inert",
        mutate: (source) =>
          source.replace(
            "  if (context.prewarmGlobeRendererEnabled === false) {",
            "  if (false && context.prewarmGlobeRendererEnabled === false) {",
          ),
      },
    ],
  });

  const { device } = makeFakeDevice();
  const { context, constructed } = makeWarmContext({
    device,
    namespace: mutated,
    prewarmGlobeRendererEnabled: false,
  });

  warmQuietly(mutated, context);

  assert.equal(
    constructed.length,
    1,
    "B2 asserts zero; with the guard unreachable the warm must run anyway",
  );
});

test("D3 MUTATION: a per-instance census stops answering for the device", async () => {
  const mutated = await load({
    overrides: [
      {
        basename: "WebGPUShaderModuleCache.ts",
        label: "census-scoped-to-instance",
        mutate: (source) =>
          source.replace(
            "    this._census = censusForDevice(device);",
            "    this._census = {\n" +
              "      modulesCreated: 0,\n" +
              "      wgslBytes: 0,\n" +
              "      largestWgslBytes: 0,\n" +
              "      cacheHits: 0,\n" +
              "    };\n" +
              "    censusForDevice(device);",
          ),
      },
    ],
  });

  const { device } = makeFakeDevice();
  new mutated.WebGPUShaderModuleCache(device).getOrCreate(
    0,
    SMALL_WGSL,
    0,
    "a",
  );
  new mutated.WebGPUShaderModuleCache(device).getOrCreate(
    1,
    LARGE_WGSL,
    0,
    "b",
  );

  assert.equal(
    mutated.getWebGPUShaderModuleCensus(device).modulesCreated,
    0,
    "A3 asserts two; with the record scoped to the instance the device sees none",
  );
});

// ── E. the option's default, and the census on the debug surface ────────────
//
// The groups above pin the CALL SITE: they hand `warmUpGlobeRenderer` a
// context whose `prewarmGlobeRendererEnabled` is already decided. Nothing in
// them executes the getter that DECIDES it, so a one-token edit there
// (`!== false` becoming `=== true`) would decline the warm for every WebGPU
// context and leave every assertion above green. The same holds for the
// census's only published surface,
// `getRendererStatistics().shaderModuleCache`. Both are executed here, from
// the shipped `WebGPUContext` source.
//
// A SECOND graph, deliberately. Adding the context to the entry above would
// drag its whole import surface into the graph the warm assertions depend on.
// This entry carries the context, the cache and the warm together, so the
// option, the decision, the compile and the census are one chain here too.

const CONTEXT_ENTRY_PATH = resolve(ENGINE_WEBGPU, "__prewarm-default.ts");
const CONTEXT_ENTRY_SOURCE = [
  'export { default as WebGPUContext } from "./WebGPUContext.js";',
  "export {",
  "  WebGPUShaderModuleCache,",
  "  getWebGPUShaderModuleCensus,",
  '} from "./WebGPUShaderModuleCache.js";',
  'export { warmUpGlobeRenderer } from "../../Scene/GlobeSurfaceTileProviderRendering.js";',
  "",
].join("\n");

/**
 * Bundles the context alongside the cache and the warm.
 *
 * @param {object} [options] Bundler overrides, for the mutants.
 * @returns {Promise<Record<string, unknown>>} The bundled namespace.
 */
function loadWithContext(options = {}) {
  return bundle({
    path: CONTEXT_ENTRY_PATH,
    source: CONTEXT_ENTRY_SOURCE,
    real: ["WebGPUContext.ts", ...REAL],
    preseed: PRESEED,
    ...options,
  });
}

const CONTEXT_NAMESPACE = await loadWithContext();

/**
 * A real `WebGPUContext` with only its private fields supplied.
 *
 * The prototype is the shipped one, so `device`, `prewarmGlobeRendererEnabled`
 * and `getRendererStatistics` are the shipped implementations rather than
 * stand-ins. The constructor is not run because it needs an adapter and a
 * canvas; the fields it would set that these paths read are set here instead.
 *
 * @param {object} input The namespace, the device and the raw options object.
 * @returns {object} The context.
 */
function makeRealContext({ namespace, device, contextOptions }) {
  const context = Object.create(namespace.WebGPUContext.prototype);
  context._options = contextOptions;
  context._id = "ctx-census-spec";
  context._device = device;
  context._canvasFormat = "bgra8unorm";
  context.isDestroyed = () => false;
  context.getFeatureRenderer = () => undefined;
  return context;
}

test("E1: the default is decided by the shipped getter, and only an explicit false declines", () => {
  const { device } = makeFakeDevice();
  const enabledFor = (contextOptions) =>
    makeRealContext({
      namespace: CONTEXT_NAMESPACE,
      device,
      contextOptions,
    }).prewarmGlobeRendererEnabled;

  assert.equal(enabledFor({}), true, "a caller naming no option is warmed");
  assert.equal(enabledFor({ prewarmGlobeRenderer: true }), true);
  assert.equal(enabledFor({ prewarmGlobeRenderer: false }), false);
  // Every other value keeps the warm. A reading that treated these as an
  // opt-out would move the terrain compile onto the first tile draw for any
  // caller that passed an unset or absent field through.
  assert.equal(enabledFor({ prewarmGlobeRenderer: undefined }), true);
  assert.equal(enabledFor({ prewarmGlobeRenderer: null }), true);
  assert.equal(enabledFor({ prewarmGlobeRenderer: 0 }), true);
});

test("E2: the option reaches the warm through the shipped getter, and declining compiles nothing", () => {
  const warmed = makeFakeDevice();
  const declined = makeFakeDevice();

  for (const [source, contextOptions] of [
    [warmed, {}],
    [declined, { prewarmGlobeRenderer: false }],
  ]) {
    const { context } = makeWarmContext({
      device: source.device,
      namespace: CONTEXT_NAMESPACE,
    });
    const real = makeRealContext({
      namespace: CONTEXT_NAMESPACE,
      device: source.device,
      contextOptions,
    });
    // The warm's context is the REAL one; only the feature-renderer seam is
    // supplied, so the decision under test travels option -> getter -> warm.
    real.getFeatureRenderer = context.getFeatureRenderer;
    warmQuietly(CONTEXT_NAMESPACE, real);
  }

  assert.ok(
    warmed.compiles.length > 0,
    "a context naming no option must still compile the warm's shader text",
  );
  assert.equal(
    declined.compiles.length,
    0,
    "an opted-out context must hand the device nothing",
  );
});

test("E3: the census is published on the debug surface, and is absent before anything compiled", () => {
  const { device } = makeFakeDevice();
  const context = makeRealContext({
    namespace: CONTEXT_NAMESPACE,
    device,
    contextOptions: {},
  });

  assert.equal(
    context.getRendererStatistics().shaderModuleCache,
    undefined,
    "an unmeasured device must be absent from the surface, not zeroed on it",
  );

  const cache = new CONTEXT_NAMESPACE.WebGPUShaderModuleCache(device);
  cache.getOrCreate(0, SMALL_WGSL, 0, "a");
  cache.getOrCreate(1, LARGE_WGSL, 0, "b");

  const published = context.getRendererStatistics().shaderModuleCache;
  assert.deepEqual(
    published,
    CONTEXT_NAMESPACE.getWebGPUShaderModuleCensus(device),
    "the surface must publish the device's own census",
  );
  assert.equal(published.wgslBytes, SMALL_WGSL.length + LARGE_WGSL.length);
});

test("E4: a context with no device publishes no census rather than another device's", () => {
  const { device } = makeFakeDevice();
  new CONTEXT_NAMESPACE.WebGPUShaderModuleCache(device).getOrCreate(
    0,
    SMALL_WGSL,
    0,
    "a",
  );
  const context = makeRealContext({
    namespace: CONTEXT_NAMESPACE,
    device: null,
    contextOptions: {},
  });

  assert.equal(context.getRendererStatistics().shaderModuleCache, undefined);
});

test("D4 MUTATION: an inverted default declines the warm for every context", async () => {
  const mutated = await loadWithContext({
    overrides: [
      {
        basename: "WebGPUContext.ts",
        label: "prewarm-default-inverted",
        mutate: (source) =>
          source.replace(
            "return this._options.prewarmGlobeRenderer !== false;",
            "return this._options.prewarmGlobeRenderer === true;",
          ),
      },
    ],
  });

  const { device } = makeFakeDevice();
  assert.equal(
    makeRealContext({
      namespace: mutated,
      device,
      contextOptions: {},
    }).prewarmGlobeRendererEnabled,
    false,
    "E1 asserts true; the one-token inversion must change that answer",
  );
});

test("D5 MUTATION: an unreachable publication leaves the census off the debug surface", async () => {
  const mutated = await loadWithContext({
    overrides: [
      {
        basename: "WebGPUContext.ts",
        label: "census-publication-inert",
        mutate: (source) =>
          source.replace(
            "      if (shaderModules) {",
            "      if (false && shaderModules) {",
          ),
      },
    ],
  });

  const { device } = makeFakeDevice();
  new mutated.WebGPUShaderModuleCache(device).getOrCreate(
    0,
    SMALL_WGSL,
    0,
    "a",
  );
  const context = makeRealContext({
    namespace: mutated,
    device,
    contextOptions: {},
  });

  assert.equal(
    context.getRendererStatistics().shaderModuleCache,
    undefined,
    "E3 asserts the published census; with the assignment unreachable it is gone",
  );
});
