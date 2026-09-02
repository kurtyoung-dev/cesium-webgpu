// Pure Node (`node --test`). No browser, build, or GPU device is required.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

// The switch the runtime honours is the exported constant in the effect file;
// the spec must observe that value, never supply its own.
const EFFECT_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUAmbientOcclusionEffect.ts";
function readLandingSwitch() {
  const source = fs.readFileSync(path.join(REPO_ROOT, EFFECT_FILE), "utf8");
  const match =
    /export const WEBGPU_AO_FULL_SAMPLE_PATTERN = (true|false);/.exec(source);
  if (!match) {
    throw new Error("landing switch not found in " + EFFECT_FILE);
  }
  return match[1] === "true";
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const BRIDGE_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts";
const bridgeSource = fs
  .readFileSync(path.join(REPO_ROOT, BRIDGE_FILE), "utf8")
  .replace(/\r\n/g, "\n");
// The bridge sources every AO uniform through this module, so the read under
// test lives here; the spec compiles the real thing rather than restating it
// as harness-supplied context.
const CONFIG_SYNC_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessConfigSync.ts";
const configSyncSource = fs
  .readFileSync(path.join(REPO_ROOT, CONFIG_SYNC_FILE), "utf8")
  .replace(/\r\n/g, "\n");

function compileConfigSync(source) {
  const code = transformSync(source, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  }).code;

  const module = { exports: {} };
  runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      // The module's only value import is the landing switch, read from the
      // effect file so the spec observes the shipped value.
      require: () => ({
        WEBGPU_AO_FULL_SAMPLE_PATTERN: readLandingSwitch(),
      }),
    },
    { filename: CONFIG_SYNC_FILE },
  );
  return module.exports;
}

function liftConfigureFunction(source) {
  const start = source.indexOf("function configureWebGPUPostProcessPipeline(");
  assert.notEqual(start, -1, `configure function missing from ${BRIDGE_FILE}`);

  const endMarker = "\n}\n\n// Minimal structural view";
  const end = source.indexOf(endMarker, start);
  assert.notEqual(
    end,
    -1,
    `configure function end missing from ${BRIDGE_FILE}`,
  );
  return source.slice(start, end + 2);
}

function compileBridge(source, configSync) {
  const typescript = [
    liftConfigureFunction(source),
    "module.exports.configureWebGPUPostProcessPipeline =",
    "  configureWebGPUPostProcessPipeline;",
  ].join("\n");

  const code = transformSync(typescript, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  }).code;

  const module = { exports: {} };
  runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      // Every AO read comes from the real config-sync module, which itself
      // reads the real landing switch. Nothing about the value under test is
      // supplied by this harness.
      numU: configSync.numU,
      readAmbientOcclusionConfigInto: configSync.readAmbientOcclusionConfigInto,
      readDepthOfFieldConfigInto: configSync.readDepthOfFieldConfigInto,
      propagateConfigIfChanged: configSync.propagateConfigIfChanged,
      AMBIENT_OCCLUSION_BUILD_ONLY_KEYS:
        configSync.AMBIENT_OCCLUSION_BUILD_ONLY_KEYS,
      AMBIENT_OCCLUSION_CONFIG_KEYS: configSync.AMBIENT_OCCLUSION_CONFIG_KEYS,
      DEPTH_OF_FIELD_CONFIG_KEYS: configSync.DEPTH_OF_FIELD_CONFIG_KEYS,
      oneTimeWarning() {},
      syncInterceptedLibraryStages() {},
      updateAmbientOcclusionFrameData() {},
    },
    { filename: BRIDGE_FILE },
  );
  return module.exports.configureWebGPUPostProcessPipeline;
}

const EFFECT_SLOTS = new Set([
  "taaEffect",
  "motionBlurEffect",
  "bloomEffect",
  "sunHaloEffect",
  "sunBloomEffect",
  "godRayEffect",
  "heatShimmerEffect",
  "coldOpticsEffect",
  "aerialPerspectiveEffect",
]);

function driveBridge(source, configSync, directionCount, stepCount) {
  const configure = compileBridge(source, compileConfigSync(configSync));
  let received;

  const pipeline = new Proxy(
    {},
    {
      get(target, property) {
        if (property === "addAmbientOcclusion") {
          return (_device, _format, config) => {
            received = config;
          };
        }
        if (property in target) {
          return target[property];
        }
        if (EFFECT_SLOTS.has(property)) {
          return undefined;
        }
        return () => undefined;
      },
      set(target, property, value) {
        target[property] = value;
        return true;
      },
    },
  );

  const scene = {
    postProcessStages: {
      ambientOcclusion: {
        enabled: true,
        // Deliberately no stepSize: the library composite does not expose it.
        uniforms: { directionCount, stepCount },
      },
      _webgpuCache: {
        ambientOcclusionEnabled: true,
        aoInitialized: false,
        fxaaEnabled: false,
        bloomEnabled: false,
        depthOfFieldEnabled: false,
        tonemapMode: 0,
        _userStagesBuilt: false,
      },
    },
  };

  configure(pipeline, scene.postProcessStages, {}, "bgra8unorm", scene);
  assert.ok(received, "addAmbientOcclusion was not called");
  return received;
}

function assertBridgeValues(source, configSync, directionCount, stepCount) {
  const received = driveBridge(source, configSync, directionCount, stepCount);
  assert.equal(
    received.directionCount,
    directionCount,
    "directionCount reaching addAmbientOcclusion",
  );
  assert.equal(
    received.stepCount,
    stepCount,
    "stepCount reaching addAmbientOcclusion",
  );
}

test("WebGPU AO bridge forwards the library uniforms", async (t) => {
  await t.test("forwards explicitly set direction and step counts", () => {
    assertBridgeValues(bridgeSource, configSyncSource, 16, 32);
  });

  await t.test("uses the library's 8x32 defaults", () => {
    assertBridgeValues(bridgeSource, configSyncSource, 8, 32);
  });

  await t.test("inertness mutant short-circuits the corrected read", () => {
    const correctedRead = [
      "  out.stepCount = WEBGPU_AO_FULL_SAMPLE_PATTERN",
      "    ? numU(uniforms?.stepCount, 32)",
      "    : numU(uniforms?.stepSize, 4);",
    ].join("\n");
    const mutant = configSyncSource.replace(
      correctedRead,
      "  out.stepCount = 4;",
    );
    assert.notEqual(mutant, configSyncSource, "corrected read was not mutated");

    assert.throws(
      () => assertBridgeValues(bridgeSource, mutant, 16, 32),
      (error) =>
        error instanceof assert.AssertionError &&
        /stepCount reaching addAmbientOcclusion/.test(error.message),
      "short-circuiting the corrected read must make the bridge assertion fail",
    );
  });
});
