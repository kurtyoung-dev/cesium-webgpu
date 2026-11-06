// @purpose Pins that each cloud collection's scene-clock weather is ticked exactly once per frame on the real per-frame update order, with a census that fails closed when the frame path gains an import this spec does not account for.
// @status ACTIVE

// A collection's `_updateWeather` advances the weather state it publishes with
// its volumetric configuration, and the scene clock is read from the frame, so
// a second call in one frame is wasted work and a second tick of the provider.
// Two callers exist by design and must never overlap: `Globe.beginFrame` ticks
// the globe's managed deck (the deck is not a primitive, so no `update` reaches
// it), and `CloudCollection.update` ticks a collection that is a scene
// primitive. A third caller, such as a scene-level hook that ticks every
// collection after the globe has begun its frame, doubles the work for every
// collection it reaches. Nothing else fails when that happens: the picture is
// the same, only the cost and the provider's tick count change.
//
// WHICH PART OF THE FRAME IS REAL
//   Real:    Globe.prototype.beginFrame (a real Globe, its surface and tile
//            provider stubbed), then ViewportExecutor's updateAndRenderPrimitives,
//            which is the function Scene's render path calls to update the ground
//            primitives and the primitives, then the real PrimitiveCollection
//            update and the real CloudCollection.update and _updateWeather, and
//            the real CloudWeatherState. Any module named in REAL below is real,
//            including a Scene module the frame path imports later.
//   Stubbed: the Scene object (a bag carrying the frame state and the two
//            primitive collections), every step Scene.render runs between the
//            globe's beginFrame and the primitives update (environment, TAA,
//            alternate renderer), the globe's render, and the context (feature
//            renderer lookup, status and readiness, a volumetric-cloud request
//            slot and the frame lists). The order beginFrame then
//            updateAndRenderPrimitives is written out in this file; Scene.js
//            itself cannot run in Node.
//
// THE CENSUS FAILS CLOSED
//   The bundler keeps only the REAL modules and answers every other import with
//   a Proxy that does nothing, so a module the frame path starts importing is a
//   silent no-op here. The census reads the import lists of Globe.js,
//   ViewportExecutor.js, PrimitiveCollection.js and CloudCollection.js, and of
//   every REAL Scene module they reach, and turns the spec red for any Scene
//   module, and any cloud, weather, feature-renderer or volumetric module, that
//   is neither REAL nor on the STUBBED list with a reason.
//
// The cloud collections' option that asks for the WebGL fallback is set on in
// every drive, so a frame-path hook gated on it is exercised whenever it exists.
//
// Behaviour measured: how many times `_updateWeather` runs per collection per
// frame, and how many times the collection's weather state is ticked.
//
// Each mutant imports the engine again with a second tick injected in the real
// frame path, or with a real caller made unreachable, and requires the same
// expectations to fail.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundle, stem } from "./lib/engine-stub-bundler.mjs";

const sceneDirectory = fileURLToPath(
  new URL("../../packages/engine/Source/Scene/", import.meta.url),
).replace(/[\\/]$/, "");
const FRAMES = 3;

// Modules the bundler keeps real, by extensionless basename. The census and the
// bundle read this one list.
const REAL = [
  "CloudCollection",
  "CloudVolumetrics",
  "CloudRenderMode",
  "CloudType",
  "CloudWeatherFallback",
  "CloudWeatherState",
  "CumulusCloud",
  "FeatureRendererKey",
  "PrimitiveCollection",
  "ViewportExecutor",
  "SceneMode",
  "Pass",
  "createGuid",
  "Event",
  "destroyObject",
  "DeveloperError",
  "Check",
  "Frozen",
  "defined",
  "Math",
];

// Modules in the census scope that are deliberately Proxy stubs, each with the
// reason the behaviour under test does not depend on them.
const STUBBED = new Map(
  Object.entries({
    GlobeSurfaceShaderSet:
      "the globe's surface shader cache, read only when the globe draws, and its render is replaced",
    WaterClassificationProvider:
      "a water data provider the globe constructs; no weather or cloud tick reads it",
    GlobalCoastlineWaterClassificationProvider:
      "a water data provider the globe constructs; no weather or cloud tick reads it",
    BathymetryTensorMap:
      "a bathymetry data map the globe constructs; no weather or cloud tick reads it",
    GlobeSurfaceTileProvider:
      "the terrain tile provider; beginFrame's tile work runs against its stub and the cloud tick does not read it",
    GlobeTranslucency:
      "the globe's translucency state, unrelated to the cloud tick",
    ImageryLayer: "imagery, unrelated to the cloud tick",
    ImageryLayerCollection: "imagery, unrelated to the cloud tick",
    TileMapServiceImageryProvider:
      "the default imagery provider the globe constructs, unrelated to the cloud tick",
    GlobeNightImagery: "night imagery, unrelated to the cloud tick",
    CelestialWaterReflection:
      "a water reflection input, unrelated to the cloud tick",
    GlobeOceanWaveClock: "the ocean wave clock, unrelated to the cloud tick",
    QuadtreePrimitive:
      "terrain quadtree traversal, driven by the stubbed tile provider",
    ShadowMode: "a constant table the globe's draw path reads",
    SceneRenderer:
      "command execution helpers that updateAndRenderPrimitives does not reach before the cloud ticks",
    SceneDebug:
      "frustum debug planes, which do not read cloud collections or weather",
    BlendingState:
      "a render-state constant table for the billboard draw path, which is not run",
    CloudCollectionFS:
      "billboard fragment shader source, used only when commands are built",
    CloudCollectionVS:
      "billboard vertex shader source, used only when commands are built",
    CloudNoiseFS: "noise texture shader source, used only on the draw path",
    CloudNoiseVS: "noise texture shader source, used only on the draw path",
    WeatherProvider:
      "the weather data provider behind CloudWeatherState; the tick is counted at the state's update",
    SynopticWeatherSource:
      "a weather source behind the provider; the tick is counted at the state's update",
  }),
);

// A specifier is in the census scope when it names a Scene sibling, or a
// cloud, weather, feature-renderer or volumetric module wherever it lives.
function inCensusScope(specifier) {
  return (
    specifier.startsWith("./") ||
    /Cloud|Weather|FeatureRenderer|Volumetric/.test(stem(specifier))
  );
}

// Every static import, re-export and dynamic import specifier of a module.
function importSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /^import\s+(?:[^;"']*?\sfrom\s*)?["']([^"']+)["']/gm,
    /^export\s+[^;"']*?\sfrom\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

const CENSUS_ROOTS = [
  "Globe.js",
  "ViewportExecutor.js",
  "PrimitiveCollection.js",
  "CloudCollection.js",
];

function resolveSceneModule(importer, specifier) {
  const resolved = path.resolve(path.dirname(importer), specifier);
  if (!resolved.startsWith(sceneDirectory + path.sep)) {
    return undefined;
  }
  const candidates = [resolved, resolved.replace(/\.js$/, ".ts")];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Walks the import lists of the frame path: the four roots and every REAL
 * Scene module reached from them. Returns the in-scope imports that are
 * neither REAL nor STUBBED, as `file: specifier` strings.
 *
 * @param {Record<string, string>} [sources] Replacement source text by file
 *   basename, so a test can plant an import.
 */
function unclassifiedFrameImports(sources = {}) {
  const real = new Set(REAL);
  const unclassified = [];
  const visited = new Set();
  const queue = CENSUS_ROOTS.map((name) => path.join(sceneDirectory, name));
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const text = (
      sources[path.basename(file)] ?? readFileSync(file, "utf8")
    ).replaceAll("\r\n", "\n");
    for (const specifier of importSpecifiers(text)) {
      const name = stem(specifier);
      if (real.has(name)) {
        const next = resolveSceneModule(file, specifier);
        if (next !== undefined) {
          queue.push(next);
        }
      } else if (inCensusScope(specifier) && !STUBBED.has(name)) {
        unclassified.push(`${path.basename(file)}: ${specifier}`);
      }
    }
  }
  return unclassified;
}

async function loadFramePath({
  globeMutate,
  label,
  overrides = [],
  stubSources,
} = {}) {
  const globePath = path.join(sceneDirectory, "Globe.js");
  const source = readFileSync(globePath, "utf8").replaceAll("\r\n", "\n");
  return bundle({
    path: globePath,
    source:
      `${source}\n` +
      'import FrameCloudCollection from "./CloudCollection.js";\n' +
      'import FrameCloudRenderMode from "./CloudRenderMode.js";\n' +
      'import FramePrimitiveCollection from "./PrimitiveCollection.js";\n' +
      'import FrameSceneMode from "./SceneMode.js";\n' +
      'import FrameFeatureRendererKey from "../Renderer/FeatureRendererKey.js";\n' +
      'import { updateAndRenderPrimitives as frameUpdateAndRenderPrimitives } from "./ViewportExecutor.js";\n' +
      "export { FrameCloudCollection as CloudCollection, FrameCloudRenderMode as CloudRenderMode, FramePrimitiveCollection as PrimitiveCollection, FrameSceneMode as SceneMode, FrameFeatureRendererKey as FeatureRendererKey, frameUpdateAndRenderPrimitives as updateAndRenderPrimitives };\n",
    real: REAL,
    preseed: [
      "CloudCollection.js",
      "CloudWeatherState.js",
      "CumulusCloud.js",
      "PrimitiveCollection.js",
      "ViewportExecutor.js",
    ].map((name) => path.join(sceneDirectory, name)),
    mutate: globeMutate,
    label,
    overrides,
    stubSources,
  });
}

let baseline;
function loadBaseline() {
  baseline ??= loadFramePath();
  return baseline;
}

// ---------------------------------------------------------------------------
// The census.
// ---------------------------------------------------------------------------

test("census: every Scene, cloud and weather import on the frame path is real or a reasoned stub", () => {
  assert.deepEqual(
    unclassifiedFrameImports(),
    [],
    "a frame-path import is neither in REAL nor in STUBBED: the bundler would stub it silently",
  );
});

test("census: no module is both real and stubbed, and every stub has a reason", () => {
  assert.deepEqual(
    REAL.filter((name) => STUBBED.has(name)),
    [],
  );
  for (const [name, reason] of STUBBED) {
    assert.ok(reason.length > 20, `${name} needs a one-line reason`);
  }
});

const PLANTED_IMPORTS = [
  {
    label: "a side-effect cloud import in ViewportExecutor",
    file: "ViewportExecutor.js",
    line: 'import "./CloudSomething.js";',
    expected: "ViewportExecutor.js: ./CloudSomething.js",
  },
  {
    label: "a default cloud import in ViewportExecutor",
    file: "ViewportExecutor.js",
    line: 'import updateSomething from "./CloudSomething.js";',
    expected: "ViewportExecutor.js: ./CloudSomething.js",
  },
  {
    label: "a multi-line named Scene import in Globe",
    file: "Globe.js",
    line: 'import {\n  alpha,\n  beta,\n} from "./SceneSomething.js";',
    expected: "Globe.js: ./SceneSomething.js",
  },
  {
    label: "a Scene import in PrimitiveCollection",
    file: "PrimitiveCollection.js",
    line: 'import Something from "./SomethingElse.js";',
    expected: "PrimitiveCollection.js: ./SomethingElse.js",
  },
  {
    label: "a re-export in CloudCollection",
    file: "CloudCollection.js",
    line: 'export { thing } from "./CloudSomething.js";',
    expected: "CloudCollection.js: ./CloudSomething.js",
  },
  {
    label: "a dynamic import in CloudCollection",
    file: "CloudCollection.js",
    line: 'const later = () => import("./CloudSomething.js");',
    expected: "CloudCollection.js: ./CloudSomething.js",
  },
  {
    label: "a weather import outside the Scene directory",
    file: "CloudCollection.js",
    line: 'import Elsewhere from "../Renderer/WeatherElsewhere.js";',
    expected: "CloudCollection.js: ../Renderer/WeatherElsewhere.js",
  },
  {
    label: "a Scene import in a real module the roots reach",
    file: "CloudWeatherState.js",
    line: 'import Hidden from "./CloudHidden.js";',
    expected: "CloudWeatherState.js: ./CloudHidden.js",
  },
];

function readSceneSource(file) {
  return readFileSync(path.join(sceneDirectory, file), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
}

for (const planted of PLANTED_IMPORTS) {
  test(`census: ${planted.label} turns the spec red`, () => {
    const found = unclassifiedFrameImports({
      [planted.file]: `${planted.line}\n${readSceneSource(planted.file)}`,
    });
    assert.deepEqual(found, [planted.expected]);
  });
}

test("census: an import of a real module is accepted", () => {
  assert.deepEqual(
    unclassifiedFrameImports({
      "ViewportExecutor.js": `import Mode from "./SceneMode.js";\n${readSceneSource("ViewportExecutor.js")}`,
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// The drive.
// ---------------------------------------------------------------------------

/**
 * Counts every `_updateWeather` call on the collection and every tick of the
 * weather state it owns, wherever the call comes from.
 */
function instrument(collection) {
  const counters = { updates: 0, ticks: 0, primitiveUpdates: 0 };
  const realPrimitiveUpdate = collection.update;
  collection.update = function (frameState) {
    counters.primitiveUpdates++;
    return realPrimitiveUpdate.call(this, frameState);
  };
  const realUpdateWeather = collection._updateWeather;
  collection._updateWeather = function (frameState) {
    counters.updates++;
    return realUpdateWeather.call(this, frameState);
  };
  let held = collection._weatherState;
  const wrap = (state) => {
    if (state && !state.__counted) {
      const realUpdate = state.update;
      state.update = function (...args) {
        counters.ticks++;
        return realUpdate.apply(this, args);
      };
      state.__counted = true;
    }
    return state;
  };
  Object.defineProperty(collection, "_weatherState", {
    configurable: true,
    get: () => held,
    set: (value) => {
      held = wrap(value);
    },
  });
  held = wrap(held);
  return counters;
}

/**
 * A context with the surface the frame path reads. WebGPU carries the cloud
 * collection feature renderer; both backends carry the procedural-cloud
 * fallback renderer, its status and readiness, and a volumetric-cloud request
 * slot that a request fills and a consume empties.
 */
function makeContext(webgpu, FeatureRendererKey, counts) {
  const cloudCollectionRenderer = { update() {} };
  const proceduralRenderer = {
    updateFallback() {
      counts.fallbackRendererCalls++;
    },
  };
  let request;
  const getFeatureRenderer = (key) => {
    if (webgpu && key === FeatureRendererKey.CLOUD_COLLECTION) {
      return cloudCollectionRenderer;
    }
    return key === FeatureRendererKey.PROCEDURAL_CLOUDS
      ? proceduralRenderer
      : undefined;
  };
  return {
    getFeatureRenderer,
    getFeatureRendererStatus: (key) => ({ renderer: getFeatureRenderer(key) }),
    getFeatureRendererReadiness: () => ({ kind: "ready" }),
    get hasVolumetricCloudRequest() {
      return request !== undefined;
    },
    requestVolumetricClouds: webgpu
      ? (config) => {
          request ??= config;
        }
      : undefined,
    consumeVolumetricCloudRequest: () => {
      const taken = request;
      request = undefined;
      return taken;
    },
    instancedArrays: true,
  };
}

/**
 * Drives `frames` frames through beginFrame then the primitives update and
 * returns, per frame, the counters' change for the managed deck and the user
 * collection.
 */
function driveFrames(
  api,
  { webgpu, managedOn, userOn, fallbackOption = true, frames = FRAMES },
) {
  const { default: Globe, CloudCollection, PrimitiveCollection } = api;
  const counts = { fallbackRendererCalls: 0 };
  const context = makeContext(webgpu, api.FeatureRendererKey, counts);
  const globe = new Globe({ maximumRadius: 6378137, minimumRadius: 6356752 });
  globe.render = () => {};
  const managed = globe.defaultCloudCollection;
  managed.enableVolumetric = managedOn;
  managed.volumetric.cloudWeatherMap = true;
  managed.volumetric.cloudWeatherFallback = fallbackOption;
  const managedCounters = instrument(managed);

  const primitives = new PrimitiveCollection();
  const user = new CloudCollection({ enableVolumetric: userOn });
  user.volumetric.cloudWeatherMap = true;
  user.volumetric.cloudWeatherFallback = fallbackOption;
  const userCounters = instrument(user);
  primitives.add(user);

  const frameState = {
    context,
    frameNumber: 0,
    mode: api.SceneMode.SCENE3D,
    passes: { render: true, pick: false, pickVoxel: false },
    afterRender: [],
    commandList: [],
    shadowMaps: [],
    shadowState: { shadowsEnabled: false, lastDirtyTime: 0 },
    time: undefined,
  };
  const scene = {
    _frameState: frameState,
    frameState,
    mode: frameState.mode,
    _globe: globe,
    globe,
    _groundPrimitives: new PrimitiveCollection(),
    _primitives: primitives,
  };

  const perFrame = [];
  try {
    for (let frame = 0; frame < frames; frame++) {
      frameState.frameNumber++;
      frameState.time = { dayNumber: 2461333, secondsOfDay: 43200 + frame };
      const before = {
        managed: { ...managedCounters },
        user: { ...userCounters },
      };
      globe.beginFrame(frameState);
      api.updateAndRenderPrimitives(scene);
      perFrame.push({
        managed: {
          updates: managedCounters.updates - before.managed.updates,
          ticks: managedCounters.ticks - before.managed.ticks,
          primitiveUpdates:
            managedCounters.primitiveUpdates - before.managed.primitiveUpdates,
        },
        user: {
          updates: userCounters.updates - before.user.updates,
          ticks: userCounters.ticks - before.user.ticks,
          primitiveUpdates:
            userCounters.primitiveUpdates - before.user.primitiveUpdates,
        },
      });
    }
    return {
      perFrame,
      managedState: managed._weatherState !== undefined,
      userState: user._weatherState !== undefined,
      fallbackRendererCalls: counts.fallbackRendererCalls,
    };
  } finally {
    managed._weatherState?.destroy();
    user._weatherState?.destroy();
  }
}

/**
 * The expectations of one run. WebGPU: each collection whose deck is on is
 * ticked exactly once per frame, by exactly one caller. WebGL: a collection is
 * ticked at most once per frame and never creates weather state.
 */
function assertWeatherTickedOncePerFrame(run, { webgpu, managedOn, userOn }) {
  run.perFrame.forEach((frame, index) => {
    const at = `frame ${index + 1}`;
    assert.equal(
      frame.user.primitiveUpdates,
      1,
      `${at}: the primitives update reaches the user collection`,
    );
    assert.equal(
      frame.managed.primitiveUpdates,
      0,
      `${at}: the managed deck is not a primitive, no update reaches it`,
    );
    assert.equal(
      frame.managed.updates,
      1,
      `${at}: the managed deck is updated once by the globe's beginFrame`,
    );
    if (webgpu) {
      assert.equal(
        frame.user.updates,
        1,
        `${at}: a user collection is updated once by its own update`,
      );
      assert.equal(frame.managed.ticks, managedOn ? 1 : 0, `${at}: managed`);
      assert.equal(frame.user.ticks, userOn ? 1 : 0, `${at}: user`);
    } else {
      assert.ok(
        frame.user.updates <= 1,
        `${at}: at most one update of the user collection`,
      );
      assert.equal(frame.managed.ticks, 0, `${at}: no weather tick on WebGL`);
      assert.equal(frame.user.ticks, 0, `${at}: no weather tick on WebGL`);
    }
  });
  assert.equal(run.managedState, webgpu && managedOn, "managed weather state");
  assert.equal(run.userState, webgpu && userOn, "user weather state");
}

const SCENARIOS = [
  { name: "the managed deck only", managedOn: true, userOn: false },
  { name: "a user collection only", managedOn: false, userOn: true },
  {
    name: "the managed deck and a user collection",
    managedOn: true,
    userOn: true,
  },
];

for (const webgpu of [true, false]) {
  for (const scenario of SCENARIOS) {
    test(`${webgpu ? "WebGPU" : "WebGL"}: ${scenario.name} tick their weather once per frame`, async () => {
      const api = await loadBaseline();
      const options = { webgpu, ...scenario };
      assertWeatherTickedOncePerFrame(driveFrames(api, options), options);
    });
  }
}

// ---------------------------------------------------------------------------
// Inertness mutants: the same drive, with the real frame path altered.
// ---------------------------------------------------------------------------

/** Replaces `from` by `to`, which must occur exactly once in `source`. */
function replaceOnce(source, from, to) {
  assert.equal(
    source.split(from).length,
    2,
    `the anchor must occur exactly once: ${from.slice(0, 60)}`,
  );
  return source.replace(from, () => to);
}

const GLOBE_BEGIN_FRAME_CALL =
  "    this._defaultCloudCollection?._updateWeather?.(frameState);";
const COLLECTION_UPDATE_CALL =
  "      this._updateWeather(frameState);\n      if (";
const COLLECTION_RENDERER_GATE =
  "      defined(\n        frameState.context?.getFeatureRenderer?.(";
const PRIMITIVES_UPDATE_CALL = "    scene._primitives.update(frameState);";
const EXECUTOR_LAST_IMPORT = 'import SceneMode from "./SceneMode.js";';
const EXECUTOR_GLOBE_RENDER = "    scene._globe.render(frameState);\n  }\n";

/**
 * A module with the shape of a frame-path hook that ticks the managed deck
 * when an option asks for the WebGL fallback, then drives the procedural-cloud
 * fallback renderer. It carries the numeric keys inline because a stub module
 * cannot import.
 */
function frameHookSource({ proceduralClouds, scene3D, volumetric }) {
  return `
export default function updateCloudWeatherFallback(scene, frameState) {
  if (!frameState.passes.render) {
    return;
  }
  const context = frameState.context;
  const collection = scene.globe?.defaultCloudCollection;
  const managed = scene.globe?.show !== false ? collection : undefined;
  const eligible =
    managed?.show !== false &&
    managed?.renderMode === ${volumetric} &&
    managed.volumetric?.enabled === true;
  const managedFallback =
    eligible && managed.volumetric.cloudWeatherFallback === true;
  if (managedFallback) {
    collection?._updateWeather?.(frameState);
  }
  if (
    frameState.mode !== ${scene3D} ||
    (!context.hasVolumetricCloudRequest && !managedFallback)
  ) {
    const status = context.getFeatureRendererStatus(${proceduralClouds});
    status.renderer?.updateFallback?.(frameState, undefined);
    return;
  }
  const readiness = context.getFeatureRendererReadiness(${proceduralClouds});
  if (readiness.kind !== "ready") {
    return;
  }
  const renderer = context.getFeatureRenderer(${proceduralClouds});
  if (!renderer?.updateFallback) {
    return;
  }
  const request = context.consumeVolumetricCloudRequest();
  const config =
    request?.enabled === true
      ? request
      : managedFallback
        ? managed._resolveVolumetricConfig()
        : undefined;
  renderer.updateFallback(frameState, config);
}
`;
}

/** The executor rewrite that imports the hook and calls it after the globe renders. */
function installFrameHook(source) {
  const imported = replaceOnce(
    source,
    EXECUTOR_LAST_IMPORT,
    `${EXECUTOR_LAST_IMPORT}\nimport updateCloudWeatherFallback from "./CloudWeatherFallback.js";`,
  );
  return replaceOnce(
    imported,
    EXECUTOR_GLOBE_RENDER,
    `${EXECUTOR_GLOBE_RENDER}  updateCloudWeatherFallback(scene, frameState);\n`,
  );
}

const MUTANTS = [
  {
    label: "a second tick of the managed deck next to the beginFrame call",
    globeMutate: (source) =>
      replaceOnce(
        source,
        GLOBE_BEGIN_FRAME_CALL,
        `${GLOBE_BEGIN_FRAME_CALL}\n${GLOBE_BEGIN_FRAME_CALL}`,
      ),
    reason: /frame 1: the managed deck is updated once/,
    scenario: { webgpu: true, managedOn: true, userOn: false },
  },
  {
    label: "the beginFrame call made unreachable",
    globeMutate: (source) =>
      replaceOnce(
        source,
        GLOBE_BEGIN_FRAME_CALL,
        `    if (false) ${GLOBE_BEGIN_FRAME_CALL.trim()}`,
      ),
    reason: /frame 1: the managed deck is updated once/,
    scenario: { webgpu: true, managedOn: true, userOn: false },
  },
  {
    label: "a second tick inside CloudCollection.update",
    collectionMutate: (source) =>
      replaceOnce(
        source,
        COLLECTION_UPDATE_CALL,
        "      this._updateWeather(frameState);\n      this._updateWeather(frameState);\n      if (",
      ),
    reason: /frame 1: a user collection is updated once/,
    scenario: { webgpu: true, managedOn: false, userOn: true },
  },
  {
    label: "the CloudCollection.update call made unreachable",
    collectionMutate: (source) =>
      replaceOnce(
        source,
        COLLECTION_UPDATE_CALL,
        "      if (false) this._updateWeather(frameState);\n      if (",
      ),
    reason: /frame 1: a user collection is updated once/,
    scenario: { webgpu: true, managedOn: false, userOn: true },
  },
  {
    label:
      "a scene-level hook that ticks every collection after the primitives update",
    executorMutate: (source) =>
      replaceOnce(
        source,
        PRIMITIVES_UPDATE_CALL,
        `${PRIMITIVES_UPDATE_CALL}\n` +
          "    scene._globe._defaultCloudCollection?._updateWeather?.(frameState);\n" +
          "    scene._primitives.get(0)?._updateWeather?.(frameState);",
      ),
    reason: /frame 1: the managed deck is updated once/,
    scenario: { webgpu: true, managedOn: true, userOn: true },
  },
  {
    label: "the feature-renderer gate removed from the weather tick",
    collectionMutate: (source) =>
      replaceOnce(
        source,
        COLLECTION_RENDERER_GATE,
        `      true ||\n${COLLECTION_RENDERER_GATE}`,
      ),
    reason: /no weather tick on WebGL/,
    scenario: { webgpu: false, managedOn: true, userOn: true },
  },
  ...[true, false].map((webgpu) => ({
    label: `a fallback hook in a new module, called from the frame path with its option on (${webgpu ? "WebGPU" : "WebGL"})`,
    hook: true,
    reason: /frame 1: the managed deck is updated once/,
    scenario: { webgpu, managedOn: true, userOn: false },
  })),
];

async function loadMutantFramePath(mutant) {
  const overrides = [];
  if (mutant.collectionMutate) {
    overrides.push({
      basename: "CloudCollection.js",
      mutate: mutant.collectionMutate,
      label: mutant.label,
    });
  }
  if (mutant.executorMutate) {
    overrides.push({
      basename: "ViewportExecutor.js",
      mutate: mutant.executorMutate,
      label: mutant.label,
    });
  }
  let stubSources;
  if (mutant.hook) {
    const api = await loadBaseline();
    overrides.push({
      basename: "ViewportExecutor.js",
      mutate: installFrameHook,
      label: mutant.label,
    });
    stubSources = {
      "./CloudWeatherFallback.js": frameHookSource({
        proceduralClouds: api.FeatureRendererKey.PROCEDURAL_CLOUDS,
        scene3D: api.SceneMode.SCENE3D,
        volumetric: api.CloudRenderMode.VOLUMETRIC,
      }),
    };
  }
  return loadFramePath({
    globeMutate: mutant.globeMutate,
    label: mutant.label,
    overrides,
    stubSources,
  });
}

for (const mutant of MUTANTS) {
  test(`mutant: ${mutant.label} turns the expectations red`, async () => {
    const api = await loadMutantFramePath(mutant);
    assert.throws(
      () =>
        assertWeatherTickedOncePerFrame(
          driveFrames(api, mutant.scenario),
          mutant.scenario,
        ),
      { name: "AssertionError", message: mutant.reason },
      `${mutant.label} must fail the once-per-frame expectations`,
    );
  });
}

for (const webgpu of [true, false]) {
  test(`control: the same fallback hook with its option off is reached and stays green (${webgpu ? "WebGPU" : "WebGL"})`, async () => {
    const api = await loadMutantFramePath({
      label: "the fallback hook with its option off",
      hook: true,
    });
    const options = {
      webgpu,
      managedOn: true,
      userOn: true,
      fallbackOption: false,
    };
    const run = driveFrames(api, options);
    assertWeatherTickedOncePerFrame(run, options);
    assert.equal(
      run.fallbackRendererCalls,
      FRAMES,
      "the hook ran every frame, so the green result is the option and not an unreached hook",
    );
  });
}
