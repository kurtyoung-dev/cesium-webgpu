// Browser-free contract for dynamic-environment position refresh parity.
// @purpose Proves WebGPU refreshes a position-dependent environment bake on the same component-wise movement threshold as WebGL.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineSource = resolve(directory, "../../packages/engine/Source");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      typeof context.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      const asJs = new URL(specifier, context.parentURL);
      if (
        asJs.pathname.includes("/packages/engine/Source/Shaders/") &&
        !fs.existsSync(fileURLToPath(asJs))
      ) {
        return {
          url: "data:text/javascript,export default%20%22%22%3B",
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      const source = fs.readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        source: ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            verbatimModuleSyntax: false,
          },
        }).outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

enableEngineTsResolution();

const {
  DEFAULT_DYNAMIC_ENVIRONMENT_MAP_POSITION_EPSILON,
  isDynamicEnvironmentMapRefreshRequested,
  shouldRefreshDynamicEnvironmentMapPosition,
  updatePreflightedWebGPUDynamicEnvironmentMap,
} = await import(
  pathToFileURL(
    resolve(
      engineSource,
      "Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
    ),
  ).href
);
const { default: DynamicEnvironmentMapManager } = await import(
  pathToFileURL(resolve(engineSource, "Scene/DynamicEnvironmentMapManager.js"))
    .href
);
const { quantizeEclipseEnvironmentRefreshInput, resolveEclipseCloudFactor } =
  await import(
    pathToFileURL(resolve(engineSource, "Scene/EclipseCloudResponse.js")).href
  );

const epsilon = DEFAULT_DYNAMIC_ENVIRONMENT_MAP_POSITION_EPSILON;
const origin = Object.freeze({ x: 0.0, y: 0.0, z: 0.0 });

function committedPosition(x, y, z) {
  return {
    lastPositionX: x,
    lastPositionY: y,
    lastPositionZ: z,
  };
}

function shouldRefresh(position, cache = committedPosition(0.0, 0.0, 0.0)) {
  return shouldRefreshDynamicEnvironmentMapPosition(cache, position, epsilon);
}

function webGlSetterRequestsRefresh(maximumPositionEpsilon, position) {
  const manager = new DynamicEnvironmentMapManager({ maximumPositionEpsilon });
  manager.position = origin;
  manager._shouldReset = false;
  manager.position = position;
  return manager._shouldReset;
}

test("first position comparison refreshes from NaN bookkeeping", () => {
  assert.equal(
    shouldRefresh(
      origin,
      committedPosition(Number.NaN, Number.NaN, Number.NaN),
    ),
    true,
  );
});

test("an unchanged position does not refresh", () => {
  assert.equal(shouldRefresh(origin), false);
});

test("movement beyond the epsilon on one component refreshes", () => {
  assert.equal(shouldRefresh({ x: epsilon + 1.0, y: 0.0, z: 0.0 }), true);
});

test("sub-epsilon component jitter does not refresh", () => {
  assert.equal(
    shouldRefresh({ x: epsilon * 0.75, y: epsilon * 0.75, z: 0.0 }),
    false,
  );
});

test("movement exactly at the inclusive upstream boundary does not refresh", () => {
  assert.equal(shouldRefresh({ x: epsilon, y: 0.0, z: 0.0 }), false);
});

test("an undefined live position is guarded without requesting a refresh", () => {
  assert.equal(shouldRefresh(undefined), false);
});

test("the WebGPU fallback epsilon equals the constructed WebGL default", () => {
  const webGlManager = new DynamicEnvironmentMapManager();
  assert.equal(
    DEFAULT_DYNAMIC_ENVIRONMENT_MAP_POSITION_EPSILON,
    webGlManager.maximumPositionEpsilon,
  );
});

const allOtherTermsFalse = Object.freeze({
  sunMoved: false,
  lutPathChanged: false,
  eclipseEnvChanged: false,
  cloudCoverageMoved: false,
  cloudRevisionChanged: false,
  cloudMarchPathChanged: false,
  captureModeChanged: false,
  captureSourceStateChanged: false,
  captureRefresh: false,
});

test("the default-path gate refreshes on position alone with capture disabled", () => {
  const cache = {
    needsUpdate: false,
    ...committedPosition(0.0, 0.0, 0.0),
  };
  const manager = {
    _position: { x: epsilon + 1.0, y: 0.0, z: 0.0 },
    maximumPositionEpsilon: epsilon,
    enableSceneCapture: false,
  };

  assert.equal(
    isDynamicEnvironmentMapRefreshRequested(manager, cache, allOtherTermsFalse),
    true,
  );

  manager._position = origin;
  assert.equal(
    isDynamicEnvironmentMapRefreshRequested(manager, cache, allOtherTermsFalse),
    false,
  );
});

test("the real gate honors a manager-configured position epsilon", () => {
  const webGlManager = new DynamicEnvironmentMapManager({
    maximumPositionEpsilon: 40.0,
  });
  const manager = {
    _position: { x: 41.0, y: 0.0, z: 0.0 },
    maximumPositionEpsilon: webGlManager.maximumPositionEpsilon,
  };
  const cache = {
    needsUpdate: false,
    ...committedPosition(0.0, 0.0, 0.0),
  };

  assert.equal(
    isDynamicEnvironmentMapRefreshRequested(manager, cache, allOtherTermsFalse),
    true,
  );

  manager._position.x = 40.0;
  assert.equal(
    isDynamicEnvironmentMapRefreshRequested(manager, cache, allOtherTermsFalse),
    false,
  );
});

test("configured numeric edge cases match the actual WebGL setter", () => {
  const cases = [
    {
      name: "negative epsilon",
      maximumPositionEpsilon: -40.0,
      position: { x: 1.0, y: 0.0, z: 0.0 },
    },
    {
      name: "subnormal squared epsilon",
      maximumPositionEpsilon: Number.MIN_VALUE,
      position: { x: Number.MIN_VALUE * 2.0, y: 0.0, z: 0.0 },
    },
    {
      name: "overflowing squared epsilon",
      maximumPositionEpsilon: Number.MAX_VALUE / 2.0,
      position: { x: Number.MAX_VALUE * 0.75, y: 0.0, z: 0.0 },
    },
  ];

  for (const entry of cases) {
    assert.equal(
      shouldRefreshDynamicEnvironmentMapPosition(
        committedPosition(0.0, 0.0, 0.0),
        entry.position,
        entry.maximumPositionEpsilon,
      ),
      webGlSetterRequestsRefresh(entry.maximumPositionEpsilon, entry.position),
      entry.name,
    );
  }
});

function createProductionGateHarness(position) {
  let scheduleCalls = 0;
  const device = {};
  const context = {
    device,
    scheduleEnvironmentRefresh() {
      scheduleCalls++;
      return "defer";
    },
    consumeEnvironmentRefreshResume() {
      return false;
    },
  };
  const frameState = {
    context,
    mode: 3,
    atmosphere: { dynamicLighting: 0 },
    globeVisible: true,
    afterRender: [],
  };
  const cache = {
    context,
    device,
    resourceGeneration: 0,
    pendingRefresh: null,
    cubemapTexture: {},
    cubemapTextureView: {},
    sampler: {},
    size: 256,
    mipmapLevels: 1,
    cubemapFormat: "rgba8unorm",
    needsUpdate: false,
    framesSinceUpdate: 0,
    lastSunDirX: 0.3,
    lastSunDirY: 0.0,
    lastSunDirZ: 0.95,
    ...committedPosition(0.0, 0.0, 0.0),
    lastUsedMultiScatterLut: false,
    lastCloudCoverage: 0.0,
    lastCloudRevision: 0,
    lastUsedCloudMarch: false,
    lastEclipseEnvBucket: quantizeEclipseEnvironmentRefreshInput(
      resolveEclipseCloudFactor(frameState),
    ),
    lastSceneCaptureMode: 0,
    lastSceneCaptureSourceRevision: -1,
    iblCache: {
      irradianceView: null,
      radianceView: null,
      sampler: null,
    },
    shBuffer: {},
  };
  const manager = {
    _mipmapLevels: 1,
    enabled: true,
    shouldUpdate: true,
    _position: position,
    maximumPositionEpsilon: epsilon,
    _shouldRegenerateShaders: false,
    _webgpuCache: cache,
    _cubemapSize: 256,
    enableSceneCapture: false,
  };

  return {
    frameState,
    manager,
    getScheduleCalls() {
      return scheduleCalls;
    },
  };
}

test("the production update reaches the scheduler for position alone", () => {
  const moved = createProductionGateHarness({
    x: epsilon + 1.0,
    y: 0.0,
    z: 0.0,
  });
  updatePreflightedWebGPUDynamicEnvironmentMap(moved.manager, moved.frameState);
  assert.equal(moved.getScheduleCalls(), 1);

  const unchanged = createProductionGateHarness(origin);
  updatePreflightedWebGPUDynamicEnvironmentMap(
    unchanged.manager,
    unchanged.frameState,
  );
  assert.equal(unchanged.getScheduleCalls(), 0);
});
