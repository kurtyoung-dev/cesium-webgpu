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

function compileBridge(source) {
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
      // Exercise the corrected side independently of the landing default.
      WEBGPU_AO_FULL_SAMPLE_PATTERN: readLandingSwitch(),
      numU(value, fallback) {
        return typeof value === "number" ? value : fallback;
      },
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

function driveBridge(source, directionCount, stepCount) {
  const configure = compileBridge(source);
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

function assertBridgeValues(source, directionCount, stepCount) {
  const received = driveBridge(source, directionCount, stepCount);
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
    assertBridgeValues(bridgeSource, 16, 32);
  });

  await t.test("uses the library's 8x32 defaults", () => {
    assertBridgeValues(bridgeSource, 8, 32);
  });

  await t.test("inertness mutant short-circuits the corrected read", () => {
    const correctedRead = [
      "    const aoStepCount = WEBGPU_AO_FULL_SAMPLE_PATTERN",
      "      ? numU(ao?.uniforms?.stepCount, 32)",
      "      : numU(ao?.uniforms?.stepSize, 4);",
    ].join("\n");
    const mutant = bridgeSource.replace(
      correctedRead,
      "    const aoStepCount = 4;",
    );
    assert.notEqual(mutant, bridgeSource, "corrected read was not mutated");

    assert.throws(
      () => assertBridgeValues(mutant, 16, 32),
      (error) =>
        error instanceof assert.AssertionError &&
        /stepCount reaching addAmbientOcclusion/.test(error.message),
      "short-circuiting the corrected read must make the bridge assertion fail",
    );
  });
});
