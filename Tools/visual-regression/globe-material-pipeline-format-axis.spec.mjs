import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
enableEngineTsResolution();

// The renderer reaches a const enum and generated shader modules that Node's
// strip-only TypeScript loader cannot consume. Transform TypeScript in memory
// and replace only absent generated shader-string modules; neither substitute
// participates in the cache behavior exercised below.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:")
    ) {
      const candidateUrl = new URL(specifier, context.parentURL);
      const candidatePath = fileURLToPath(candidateUrl);
      const normalizedPath = candidatePath.replaceAll("\\", "/");
      if (
        !fs.existsSync(candidatePath) &&
        normalizedPath.includes("/packages/engine/Source/Shaders/")
      ) {
        return {
          url: `data:text/javascript,export default %22%22;#${encodeURIComponent(candidatePath)}`,
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      const source = fs.readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        source: stripTypeScriptTypes(source, {
          mode: "transform",
          sourceMap: false,
        }),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { buildGlobePipelineCacheKey, parseGlobePipelineCacheKey } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelineKey.ts");
const { WebGPUGlobeSurfaceRenderer } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts");

const BOOLEAN_VALUES = [false, true];

function materialKeySpec(overrides = {}) {
  return {
    kind: "color",
    isQuantized: false,
    hasNormals: true,
    hasWebMercatorT: false,
    isBlend: false,
    strideBytes: 17,
    useClipDistances: false,
    disableCulling: false,
    defines: 0,
    ...overrides,
  };
}

function buildLegacyMatrix() {
  const kinds = [
    "color",
    "pick",
    "translucentBackFace",
    "depthOnlyBackFace",
    "depthOnlyFrontFace",
    "capture",
    "debugFragment",
    "wireframe",
  ];
  const strides = [4, 17];
  const definesValues = [0, 0x1234, -2147483648];
  const cases = [];

  for (const kind of kinds) {
    for (const isQuantized of BOOLEAN_VALUES) {
      for (const hasNormals of BOOLEAN_VALUES) {
        for (const hasWebMercatorT of BOOLEAN_VALUES) {
          for (const isBlend of BOOLEAN_VALUES) {
            for (const useClipDistances of BOOLEAN_VALUES) {
              for (const disableCulling of BOOLEAN_VALUES) {
                for (const strideBytes of strides) {
                  for (const defines of definesValues) {
                    const captureFormats =
                      kind === "capture"
                        ? ["rgba8unorm", "rgba16float"]
                        : [undefined];
                    const debugModes =
                      kind === "debugFragment" ? [0, 12] : [undefined];
                    for (const captureFaceFormat of captureFormats) {
                      for (const debugFragmentMode of debugModes) {
                        const spec = {
                          kind,
                          isQuantized,
                          hasNormals,
                          hasWebMercatorT,
                          isBlend,
                          useClipDistances,
                          disableCulling,
                          strideBytes,
                          defines,
                        };
                        if (captureFaceFormat !== undefined) {
                          spec.captureFaceFormat = captureFaceFormat;
                        }
                        if (debugFragmentMode !== undefined) {
                          spec.debugFragmentMode = debugFragmentMode;
                        }
                        cases.push(spec);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return cases;
}

test("material target axes are deterministic, distinct, and collision-resistant", () => {
  const legacyKeys = new Set();
  const targetKeys = new Set();
  const hostileFormat = "rgba8unorm|@f=forged&s=17%&=";

  for (const isQuantized of BOOLEAN_VALUES) {
    for (const hasNormals of BOOLEAN_VALUES) {
      for (const hasWebMercatorT of BOOLEAN_VALUES) {
        for (const isBlend of BOOLEAN_VALUES) {
          for (const useClipDistances of BOOLEAN_VALUES) {
            for (const disableCulling of BOOLEAN_VALUES) {
              for (const strideBytes of [4, 17]) {
                const base = materialKeySpec({
                  isQuantized,
                  hasNormals,
                  hasWebMercatorT,
                  isBlend,
                  useClipDistances,
                  disableCulling,
                  strideBytes,
                  defines: 0x11,
                });
                const legacyKey = buildGlobePipelineCacheKey(base);
                const first = buildGlobePipelineCacheKey({
                  ...base,
                  targetFormat: "rgba8unorm",
                  sampleCount: 4,
                });
                const same = buildGlobePipelineCacheKey({
                  ...base,
                  targetFormat: "rgba8unorm",
                  sampleCount: 4,
                });
                const otherFormat = buildGlobePipelineCacheKey({
                  ...base,
                  targetFormat: "rgba16float",
                  sampleCount: 4,
                });
                const otherSamples = buildGlobePipelineCacheKey({
                  ...base,
                  targetFormat: "rgba8unorm",
                  sampleCount: 17,
                });
                const hostile = buildGlobePipelineCacheKey({
                  ...base,
                  targetFormat: hostileFormat,
                  sampleCount: strideBytes,
                });

                assert.equal(first, same);
                assert.notEqual(first, otherFormat);
                assert.notEqual(first, otherSamples);
                assert.notEqual(hostile, legacyKey);
                assert.match(
                  hostile,
                  /f=rgba8unorm%7C%40f%3Dforged%26s%3D17%25%26%3D/,
                );
                legacyKeys.add(legacyKey);
                targetKeys.add(first);
                targetKeys.add(otherFormat);
                targetKeys.add(otherSamples);
                targetKeys.add(hostile);
              }
            }
          }
        }
      }
    }
  }

  const collisions = [...targetKeys].filter((key) => legacyKeys.has(key));
  assert.deepEqual(collisions, []);
});

test("omitting target axes preserves every frozen legacy key byte", () => {
  const snapshot = buildLegacyMatrix().map((spec) => [
    spec,
    buildGlobePipelineCacheKey(spec),
  ]);
  const digest = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");

  assert.equal(snapshot.length, 3840);
  assert.equal(
    digest,
    "690bdcb404debc1a8409e1f0864d20bff8a5032e48c2a72733e5b082a2de0519",
  );
  assert.equal(buildGlobePipelineCacheKey(materialKeySpec()), "UNGO_17|0");
  assert.equal(
    buildGlobePipelineCacheKey(
      materialKeySpec({
        isQuantized: true,
        hasNormals: false,
        hasWebMercatorT: true,
        isBlend: true,
        useClipDistances: true,
        disableCulling: true,
        strideBytes: 4,
        defines: 0x1234,
      }),
    ),
    "QXMB_4_CD_NC|1234",
  );
  assert.equal(
    buildGlobePipelineCacheKey({
      kind: "capture",
      isQuantized: true,
      hasNormals: true,
      hasWebMercatorT: false,
      isBlend: false,
      useClipDistances: true,
      disableCulling: true,
      strideBytes: 17,
      defines: -2147483648,
      captureFaceFormat: "rgba16float",
    }),
    "QNGO_17_CAP_rgba16float|-80000000",
  );
  assert.equal(
    buildGlobePipelineCacheKey({
      kind: "debugFragment",
      isQuantized: false,
      hasNormals: false,
      hasWebMercatorT: true,
      isBlend: true,
      useClipDistances: true,
      disableCulling: true,
      strideBytes: 4,
      defines: 0x1234,
      debugFragmentMode: 12,
    }),
    "12_UXMB_4|1234",
  );
  assert.equal(
    buildGlobePipelineCacheKey({
      kind: "wireframe",
      isQuantized: true,
      hasNormals: false,
      hasWebMercatorT: false,
      isBlend: true,
      useClipDistances: true,
      disableCulling: true,
      strideBytes: 17,
      defines: -2147483648,
    }),
    "QXG_17|-80000000",
  );

  const legacy = buildGlobePipelineCacheKey(materialKeySpec());
  const optedIn = buildGlobePipelineCacheKey(
    materialKeySpec({ targetFormat: "rgba8unorm", sampleCount: 4 }),
  );
  assert.equal(optedIn, `${legacy}|@f=rgba8unorm&s=4`);
  assert.notEqual(optedIn, legacy);
});

test("parser round-trips optional target axes and leaves omissions absent", () => {
  const targetCases = [
    { targetFormat: "rgba8unorm", sampleCount: 1 },
    { targetFormat: "rgba16float" },
    { sampleCount: 17 },
    {
      targetFormat: "rgba8unorm|@f=forged&s=17%&=",
      sampleCount: 4,
    },
  ];
  for (const targetCase of targetCases) {
    const key = buildGlobePipelineCacheKey(
      materialKeySpec({
        isQuantized: true,
        hasNormals: false,
        hasWebMercatorT: true,
        isBlend: true,
        useClipDistances: true,
        disableCulling: true,
        defines: -2147483648,
        ...targetCase,
      }),
    );
    const parsed = parseGlobePipelineCacheKey(key);
    assert.notEqual(parsed, null);
    assert.equal(parsed.targetFormat, targetCase.targetFormat);
    assert.equal(parsed.sampleCount, targetCase.sampleCount);
    assert.equal(buildGlobePipelineCacheKey(parsed), key);
  }

  const legacy = parseGlobePipelineCacheKey(
    buildGlobePipelineCacheKey(materialKeySpec()),
  );
  assert.notEqual(legacy, null);
  assert.equal(Object.hasOwn(legacy, "targetFormat"), false);
  assert.equal(Object.hasOwn(legacy, "sampleCount"), false);

  for (const malformed of [
    "UNGO_17|0|@",
    "UNGO_17|0|@f=",
    "UNGO_17|0|@f=%zz",
    "UNGO_17|0|@x=rgba8unorm",
    "UNGO_17|0|@s=4&f=rgba8unorm",
    "UNGO_17|0|@f=rgba8unorm&f=rgba16float",
    "UNGO_17|0|@s=0",
    "UNGO_17|0|@s=04",
    "UNGO_17|0|@s=1.5",
  ]) {
    assert.equal(parseGlobePipelineCacheKey(malformed), null, malformed);
  }
  assert.throws(
    () =>
      buildGlobePipelineCacheKey(
        materialKeySpec({ targetFormat: "", sampleCount: 4 }),
      ),
    /targetFormat must not be empty/,
  );
  assert.throws(
    () =>
      buildGlobePipelineCacheKey(
        materialKeySpec({ targetFormat: "rgba8unorm", sampleCount: 1.5 }),
      ),
    /sampleCount must be a positive safe integer/,
  );
});

function seedPipelineCaches(renderer) {
  renderer._pipelineCache.set("production", {});
  renderer._wireframePipelineCache.set("wireframe", {});
  renderer._debugFragmentPipelineCache.set("debug", {});
  renderer._capturePipelineCache.set("capture", {});
  renderer._materialPipelineCache.set("material", {});
}

function callMissingMeshTile(renderer, context, enableEnhancedOcean) {
  return renderer.createTileCommands(
    { level: 0, x: 0, y: 0, rectangle: {} },
    { renderedMesh: null, mesh: null },
    { enableEnhancedOcean },
    { context, useLogDepth: false, frameNumber: 1 },
    {},
  );
}

test("format-generation changes empty material pipelines but retain capture pipelines", () => {
  const renderer = new WebGPUGlobeSurfaceRenderer();
  renderer._isInitialized = true;
  renderer._device = {};
  renderer._scenePipelineFormatGeneration = 7;
  seedPipelineCaches(renderer);
  const context = {
    uniformAllocator: {},
    _scenePipelineFormatGeneration: 8,
    scenePipelineFormat: "rgba16float",
    pickPipelineFormat: "rgba8unorm",
    _msaaSamples: 4,
    _logDepthWriteEnabled: false,
    _pickLogDepthWriteEnabled: false,
  };

  assert.equal(callMissingMeshTile(renderer, context, false), null);
  assert.equal(renderer._pipelineCache.size, 0);
  assert.equal(renderer._wireframePipelineCache.size, 0);
  assert.equal(renderer._debugFragmentPipelineCache.size, 0);
  assert.equal(renderer._materialPipelineCache.size, 0);
  assert.equal(renderer._capturePipelineCache.size, 1);
  assert.equal(renderer._canvasFormat, "rgba16float");
  assert.equal(renderer._sampleCount, 4);
  assert.equal(renderer._scenePipelineFormatGeneration, 8);
});

test("enhanced-ocean flips empty material pipelines and unchanged state does not", () => {
  const renderer = new WebGPUGlobeSurfaceRenderer();
  renderer._isInitialized = true;
  renderer._device = {};
  renderer._scenePipelineFormatGeneration = 8;
  seedPipelineCaches(renderer);
  const context = {
    uniformAllocator: {},
    _scenePipelineFormatGeneration: 8,
    _logDepthWriteEnabled: false,
    _pickLogDepthWriteEnabled: false,
  };

  assert.equal(callMissingMeshTile(renderer, context, true), null);
  assert.equal(renderer._enhancedOceanEnabled, true);
  assert.equal(renderer._pipelineCache.size, 0);
  assert.equal(renderer._wireframePipelineCache.size, 0);
  assert.equal(renderer._debugFragmentPipelineCache.size, 0);
  assert.equal(renderer._capturePipelineCache.size, 0);
  assert.equal(renderer._materialPipelineCache.size, 0);

  renderer._materialPipelineCache.set("unchanged-state", {});
  assert.equal(callMissingMeshTile(renderer, context, true), null);
  assert.equal(renderer._materialPipelineCache.size, 1);
});

test("material caller keys target axes and rebuilds the ocean hi-word module", () => {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globalThis.HTMLImageElement = class HTMLImageElement {};
  globalThis.HTMLCanvasElement = class HTMLCanvasElement {};

  const materialSources = [];
  const productionModule = {};
  const device = {
    createShaderModule(descriptor) {
      materialSources.push(descriptor.code);
      return { code: descriptor.code };
    },
    createBuffer() {
      return {};
    },
    createRenderPipeline(descriptor) {
      return { descriptor };
    },
    queue: {
      writeBuffer() {},
    },
  };
  const renderer = new WebGPUGlobeSurfaceRenderer();
  renderer._device = device;
  renderer._pipelineLayout = {};
  renderer._shaderModuleCache = {
    getOrCreate() {
      return productionModule;
    },
  };
  renderer._shaderCode = [
    "//>>ifdef ENHANCED_OCEAN",
    "const oceanMode: i32 = 1;",
    "//>>else",
    "const oceanMode: i32 = 0;",
    "//>>endif",
  ].join("\n");
  renderer._canvasFormat = "bgra8unorm";
  renderer._sampleCount = 1;

  const material = {
    type: "FormatAxisMaterial",
    uniforms: { value: 1 },
    wgslShaderSource: "fn czm_getMaterial() -> f32 { return value; }",
  };
  const materialArgs = [material, false, false, false, false, 17, false, false];

  const first = renderer._getOrCreateMaterialPipeline(...materialArgs);
  assert.notEqual(first, null);
  assert.equal(materialSources.length, 1);
  assert.match(materialSources[0], /const oceanMode: i32 = 0;/);
  assert.doesNotMatch(materialSources[0], /const oceanMode: i32 = 1;/);
  assert.equal(first.entry.pipelines.size, 1);
  const firstFields = parseGlobePipelineCacheKey(
    [...first.entry.pipelines.keys()][0],
  );
  assert.equal(firstFields.targetFormat, "bgra8unorm");
  assert.equal(firstFields.sampleCount, 1);

  renderer._canvasFormat = "rgba16float";
  renderer._sampleCount = 4;
  const secondTarget = renderer._getOrCreateMaterialPipeline(...materialArgs);
  assert.notEqual(secondTarget, null);
  assert.equal(secondTarget.entry, first.entry);
  assert.equal(materialSources.length, 1);
  assert.equal(first.entry.pipelines.size, 2);
  const targetVariants = [...first.entry.pipelines.keys()].map((key) =>
    parseGlobePipelineCacheKey(key),
  );
  assert.deepEqual(
    targetVariants.map(({ targetFormat, sampleCount }) => ({
      targetFormat,
      sampleCount,
    })),
    [
      { targetFormat: "bgra8unorm", sampleCount: 1 },
      { targetFormat: "rgba16float", sampleCount: 4 },
    ],
  );

  renderer._applyEnhancedOceanState(true);
  assert.equal(renderer._materialPipelineCache.size, 0);
  const enhanced = renderer._getOrCreateMaterialPipeline(...materialArgs);
  assert.notEqual(enhanced, null);
  assert.equal(materialSources.length, 2);
  assert.match(materialSources[1], /const oceanMode: i32 = 1;/);
  assert.doesNotMatch(materialSources[1], /const oceanMode: i32 = 0;/);
});
