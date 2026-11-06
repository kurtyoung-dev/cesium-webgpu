// RUNNER REQUIREMENT: Node >= 22.18. This spec statically imports `.ts` modules
// (WebGPUCloudMarchFeatures.ts, WebGPUPipelineRequestGuard.ts), which relies on
// Node's built-in type stripping (on by default from Node 22.18).
// @purpose Pins the path from the cloud cache's weather-family flags to the high-word defines of the march pipeline request: each family's flag alone sets exactly its own define in the features object and in the defines it yields, the request compiles that define when the noise is baked, and the weather transition define is dropped from the request when it is not.
// @status ACTIVE
//
// HOW IT WORKS. The features module is imported as it stands. The renderer's
// requestCloudMarchPipeline is sliced out of WebGPUProceduralCloudRenderer.ts,
// transformed with esbuild and run in node:vm against a fake pipeline cache,
// so the request is the renderer's own code reading the cache flag and the
// uniform quality bits. Each family is one row of FAMILIES; a family that
// stops reaching its define (the cache flag unread, the features field
// unmapped, the define line dropped, the baked-noise rule inverted) turns a
// row red.

import assert from "node:assert/strict";
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
const RENDERER_PATH = path.resolve(
  here,
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const { ShaderDefineHi, ShaderSourceId } = shaderDefines;
const { cloudMarchActiveFeatures, cloudMarchFeatureDefines } = featuresModule;

// One row per weather family: the cache flag the renderer sets, the field of
// the features object it becomes, and the define it compiles.
const FAMILIES = [
  {
    name: "weather transition",
    cacheFlag: "weatherTransitionRequested",
    field: "transition",
    define: "CLOUD_WEATHER_TRANSITION",
    needsBakedNoise: true,
  },
  {
    name: "vertical weather",
    cacheFlag: "weatherVerticalRequested",
    field: "vertical",
    define: "CLOUD_WEATHER_VERTICAL",
    needsBakedNoise: false,
  },
  {
    name: "independent weather populations",
    cacheFlag: "weatherPopulationsRequested",
    field: "populations",
    define: "CLOUD_WEATHER_POPULATIONS",
    needsBakedNoise: false,
  },
];

function familyBit(family) {
  const bit = ShaderDefineHi[family.define];
  assert(
    Number.isInteger(bit) && bit > 0 && (bit & (bit - 1)) === 0,
    `${family.define} must be a registered single define bit`,
  );
  return bit;
}

test("a cache that sets only one family's flag produces exactly that family's define", () => {
  assert.equal(cloudMarchFeatureDefines(cloudMarchActiveFeatures({})), 0);
  for (const family of FAMILIES) {
    const cache = { [family.cacheFlag]: true };
    const features = cloudMarchActiveFeatures(cache);
    assert.equal(features[family.field], true, `${family.name}: field`);
    for (const other of FAMILIES) {
      if (other !== family) {
        assert.equal(features[other.field], false, `${other.name} stays off`);
      }
    }
    assert.equal(
      cloudMarchFeatureDefines(features),
      familyBit(family),
      `${family.name}: defines`,
    );
    assert.equal(
      cloudMarchFeatureDefines(
        cloudMarchActiveFeatures({ [family.cacheFlag]: false }),
      ),
      0,
      `${family.name}: a cleared flag compiles nothing`,
    );
  }
});

test("every family's flag set together compiles every family's define and nothing else", () => {
  const cache = Object.fromEntries(FAMILIES.map((f) => [f.cacheFlag, true]));
  assert.equal(
    cloudMarchFeatureDefines(cloudMarchActiveFeatures(cache)),
    FAMILIES.reduce((bits, family) => bits | familyBit(family), 0),
  );
});

function renderer() {
  return fs.readFileSync(RENDERER_PATH, "utf8").split("\r\n").join("\n");
}

async function buildRequest() {
  const source = renderer();
  const begin = source.indexOf("function requestCloudMarchPipeline(");
  const end = source.indexOf("function initializeCloudPipeline(", begin);
  assert(begin >= 0 && end > begin, "march request not found in the renderer");
  const { code } = await transform(source.slice(begin, end), {
    loader: "ts",
    format: "cjs",
  });
  class FakeModules {
    getOrCreate() {
      return {};
    }
  }
  return runInNewContext(`${code}\nrequestCloudMarchPipeline;`, {
    ...featuresModule,
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
  });
}

// The high-word defines of the march pipeline the renderer requests for a cache
// that carries the given flags, with the noise baked or not.
async function requestedDefinesHi(cacheFlags, { baked }) {
  const request = await buildRequest();
  const data = new Float32Array(176);
  data[74] = baked ? 1 : 0;
  const cache = {
    uniformData: data,
    bindGroupLayout: {},
    marchPipelines: new Map(),
    marchRequestGuard: new WebGPUPipelineRequestGuard(),
    marchModules: null,
    marchPipelineLayout: null,
    temporalHistoryPendingResetReasons: 0,
    maskPipeline: {},
    shadowPipeline: {},
    ...cacheFlags,
  };
  const asked = [];
  const context = {
    _device: { createPipelineLayout: () => ({}) },
    _cloudCache: cache,
    webgpuPipelineCache: {
      getPipelineSync: (descriptor) => {
        asked.push(descriptor.definesHi);
        return { id: descriptor.definesHi };
      },
    },
  };
  request(context, cache, "rgba16float", false);
  assert.equal(asked.length, 1, "one march pipeline request per call");
  return asked[0];
}

test("the march request compiles each family's define when the noise is baked and its flag is set", async () => {
  const none = await requestedDefinesHi({}, { baked: true });
  for (const family of FAMILIES) {
    const bit = familyBit(family);
    assert.equal(none & bit, 0, `${family.name}: absent without its flag`);
    const asked = await requestedDefinesHi(
      { [family.cacheFlag]: true },
      { baked: true },
    );
    assert.notEqual(asked & bit, 0, `${family.name}: requested with its flag`);
    assert.equal(
      asked & ~(bit | none),
      0,
      `${family.name}: no other family define rides along`,
    );
  }
});

test("the march request drops the weather transition define when the noise is not baked", async () => {
  const bit = ShaderDefineHi.CLOUD_WEATHER_TRANSITION;
  const flags = { weatherTransitionRequested: true };
  assert.notEqual((await requestedDefinesHi(flags, { baked: true })) & bit, 0);
  assert.equal(
    (await requestedDefinesHi(flags, { baked: false })) & bit,
    0,
    "an unbaked noise tier cannot sample the transition's second snapshot",
  );
  for (const family of FAMILIES.filter((f) => !f.needsBakedNoise)) {
    const asked = await requestedDefinesHi(
      { [family.cacheFlag]: true },
      { baked: false },
    );
    assert.notEqual(
      asked & familyBit(family),
      0,
      `${family.name}: kept without baked noise`,
    );
  }
});
