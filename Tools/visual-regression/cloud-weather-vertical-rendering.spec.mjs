import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import { preprocess, shaderDefines } from "./lib/wgsl-variant.mjs";
import * as math from "./lib/wgsl-mini-eval.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const rendererPath =
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts";
const renderer = read(rendererPath);
const directory = "packages/engine/Source/Shaders/WebGPU/Environment/";
const vertical = read(directory + "CloudWeatherVertical.wgsl");
function block(source, name) {
  const start = source.indexOf("fn " + name + "("),
    body = source.indexOf("{", start);
  assert.ok(start >= 0 && body > start, name);
  let i = body + 1,
    depth = 1;
  for (; depth; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  return source.slice(start, i);
}
async function bundle(contents) {
  const { outputFiles } = await build({
    stdin: { contents, resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(outputFiles[0].text).toString("base64")
  );
}
function assembled() {
  const imports = new Map(
    [
      ...renderer.matchAll(/import (\w+) from "([^"]+\/Shaders\/[^"]+\.js)";/g),
    ].map((m) => [
      m[1],
      path.posix.normalize(
        path.posix.join(
          path.posix.dirname(rendererPath),
          m[2].replace(/\.js$/, ".wgsl"),
        ),
      ),
    ]),
  );
  const line = renderer
    .split(/\r?\n/)
    .find((value) => value.startsWith("const PROCEDURAL_CLOUDS_SOURCE ="));
  return [...line.matchAll(/\$\{(\w+)\}/g)]
    .map((m) => read(imports.get(m[1])))
    .join("\n");
}
// The march-pipeline request, run from the renderer with the features module
// and a recording shader-module cache, so the define bits a request compiles
// are read from what it hands the cache.
async function marchRequest() {
  const features = await bundle(
    'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudMarchFeatures.ts";',
  );
  const begin = renderer.indexOf("function requestCloudMarchPipeline(");
  const end = renderer.indexOf("\n}", begin);
  assert.ok(begin >= 0 && end > begin, "march request not found");
  const { code } = await transform(renderer.slice(begin, end + 2), {
    loader: "ts",
    format: "cjs",
  });
  const compiled = [];
  class RecordingModules {
    getOrCreate(sourceId, source, bits, label, extra, definesHi) {
      compiled.push(definesHi);
      return {};
    }
  }
  const request = runInNewContext(`${code}\nrequestCloudMarchPipeline;`, {
    ...features,
    WebGPUShaderModuleCache: RecordingModules,
    ShaderDefineHi: shaderDefines.ShaderDefineHi,
    ShaderSourceId: shaderDefines.ShaderSourceId,
    CLOUD_QF_NOISE_BAKED: 1,
    CLOUD_MARCH_EMIT_DEFINES_HI:
      shaderDefines.ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION,
    CLOUD_MARCH_EMITTED_FORMAT: "rg32float",
    PROCEDURAL_CLOUDS_SOURCE: "fixture",
    performance: globalThis.performance,
    console,
  });
  // The defines one request compiles for a cache whose weather map asks for
  // (or leaves off) the regional heights.
  return (cacheState, requestFeatures) => {
    const uniformData = new Float32Array(176);
    uniformData[74] = 1;
    const cache = {
      uniformData,
      bindGroupLayout: {},
      marchPipelines: new Map(),
      marchModules: null,
      marchPipelineLayout: null,
      maskPipeline: {},
      shadowPipeline: {},
      ...cacheState,
    };
    const context = {
      _device: { createPipelineLayout: () => ({}) },
      _cloudCache: cache,
      webgpuPipelineCache: {
        getPipelineSync: () => ({}),
        getPipeline: () => new Promise(() => {}),
      },
    };
    compiled.length = 0;
    request(
      context,
      cache,
      "rgba16float",
      false,
      requestFeatures?.(features, cache),
    );
    assert.equal(compiled.length, 1);
    return compiled[0];
  };
}
const functionNames = (program) =>
  new Set([...program.matchAll(/\bfn\s+(\w+)\s*\(/g)].map((m) => m[1]));
const bindings = (program) =>
  [...program.matchAll(/@group\(\d+\)\s*@binding\(\d+\)[^;]*;/g)].map((m) =>
    m[0].replace(/\s+/g, " "),
  );
// The struct a `var<uniform>` binding is typed with, as normalized text.
const uniformStructs = (program) =>
  [...program.matchAll(/var<uniform>\s+\w+\s*:\s*(\w+)\s*;/g)].map((m) => {
    const body = program.match(
      new RegExp("struct\\s+" + m[1] + "\\s*\\{[^}]*\\}"),
    );
    assert.ok(body, m[1]);
    return body[0].replace(/\/\/[^\n]*/g, "").replace(/\s+/g, "");
  });

test("regional profile executes shipped height math for local, missing and partially supported intervals", () => {
  const source = math.stripComments(
    preprocess(
      vertical,
      0,
      shaderDefines.ShaderDefineHi.CLOUD_WEATHER_VERTICAL,
    ),
  );
  const globals = {
    cloud: { cloudLayerBottom: 1500, cloudLayerTop: 4000, anvilBias: 0 },
    __functions: {
      heightGradientFor: (height) => 4 * height * (1 - height),
      mix: (a, b, t) =>
        typeof a === "number"
          ? a + (b - a) * t
          : math.vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t),
    },
  };
  globals.__functions.cloudVerticalGradient = math.compileFunction(
    source,
    "cloudVerticalGradient",
    globals,
  );
  const profile = math.compileFunction(
    source,
    "cloudRegionalProfileFromMoments",
    globals,
  );
  const channels = { baseShiftFrac: 0, perGenusShape: 0 };
  const moments = (base, top, support) =>
    Object.assign(math.vec(base, top, support), { xy: math.vec2(base, top) });
  const unknown = moments(0, 0, 0),
    known = moments(1000, 9000, 1);
  assert.equal(profile(1500, channels, unknown).x, 0);
  assert.equal(profile(4000, channels, unknown).x, 1);
  assert.equal(profile(8000, channels, unknown).y, 0);
  assert.equal(profile(500, channels, known).y, 0);
  assert.equal(profile(9500, channels, known).y, 0);
  assert.equal(profile(5000, channels, known).x, 0.5);
  assert.equal(profile(5000, channels, known).y, 1);
  const partial = profile(5000, channels, moments(500, 4500, 0.5));
  assert.equal(partial.x, 0.75);
  assert.equal(partial.y, 0.5);
});

test("vertical define adds its functions without changing the bindings or uniform structs; selected variants validate", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  const flags = shaderDefines.ShaderDefineHi,
    program = assembled();
  const regional = [
    "cloudRegionalProfile",
    "cloudRegionalProfileFromMoments",
    "cloudRegionalVerticalMoments",
    "cloudVerticalGradient",
    "cloudVerticalMoments",
    "cloudVerticalTap",
  ];
  for (const selected of [
    0,
    flags.CLOUD_NOISE_BAKED_ONLY | flags.CLOUD_MORPHOLOGY_BASE_ONLY,
    flags.CLOUD_WEATHER_TRANSITION | flags.CLOUD_NOISE_BAKED_ONLY,
    flags.CLOUD_MARCH_EMIT_RECONSTRUCTION,
    flags.CLOUD_LIGHTING_PREVIEW,
  ]) {
    const off = preprocess(program, 0, selected),
      on = preprocess(program, 0, selected | flags.CLOUD_WEATHER_VERTICAL);
    const without = functionNames(off),
      withDefine = functionNames(on);
    for (const name of regional) {
      assert.equal(
        without.has(name),
        false,
        name + " compiled without the define",
      );
      assert.equal(
        withDefine.has(name),
        true,
        name + " missing with the define",
      );
    }
    for (const name of without) assert.ok(withDefine.has(name), name);
    assert.deepEqual(bindings(on), bindings(off));
    assert.ok(bindings(off).length > 0);
    assert.deepEqual(uniformStructs(on), uniformStructs(off));
    assert.ok(uniformStructs(off).length > 0);
    naga.validate_wgsl(off);
  }
  for (const selected of [
    0,
    flags.CLOUD_NOISE_BAKED_ONLY,
    flags.CLOUD_WEATHER_TRANSITION | flags.CLOUD_NOISE_BAKED_ONLY,
    flags.CLOUD_MARCH_EMIT_RECONSTRUCTION,
    flags.CLOUD_GEOGRAPHIC_WIND |
      flags.CLOUD_SINGLE_LEVEL_WIND |
      flags.CLOUD_VELOCITY_ONLY_WIND,
  ]) {
    naga.validate_wgsl(
      preprocess(program, 0, selected | flags.CLOUD_WEATHER_VERTICAL),
    );
  }
  const bit = flags.CLOUD_WEATHER_VERTICAL;
  assert.ok(bit > 0 && (bit & (bit - 1)) === 0, "one high-word bit");
  for (const [name, value] of Object.entries(flags)) {
    if (name !== "CLOUD_WEATHER_VERTICAL" && typeof value === "number") {
      assert.equal(value & bit, 0, name + " shares the vertical bit");
    }
  }
});

test("a march request compiles the vertical define only for a final draw whose weather map requested regional heights", async () => {
  const compiled = await marchRequest();
  const bit = shaderDefines.ShaderDefineHi.CLOUD_WEATHER_VERTICAL,
    preview = shaderDefines.ShaderDefineHi.CLOUD_LIGHTING_PREVIEW;
  const requested = { weatherVerticalRequested: true };
  assert.equal((compiled(requested) & bit) !== 0, true);
  assert.equal(
    (compiled({ weatherVerticalRequested: false }) & bit) !== 0,
    false,
  );
  assert.equal((compiled({}) & bit) !== 0, false);
  const drawnAsPreview = compiled(requested, (features, cache) => ({
    ...features.cloudMarchActiveFeatures(cache),
    preview: true,
  }));
  assert.equal((drawnAsPreview & preview) !== 0, true);
  assert.equal((drawnAsPreview & bit) !== 0, false);
  const features = await bundle(
    'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudMarchFeatures.ts";',
  );
  assert.equal(features.cloudMarchActiveFeatures(requested).vertical, true);
  assert.equal(features.cloudMarchActiveFeatures({}).vertical, false);
  assert.equal(features.cloudMarchFeatureDefines({ vertical: true }), bit);
  assert.equal(features.cloudMarchFeatureDefines({}), 0);
});

test("actual weather upload publishes coherent optional planes, reuses identities and retires changed layouts", async () => {
  const source = block(
    renderer.replace("function ensureWeatherView(", "fn ensureWeatherView("),
    "ensureWeatherView",
  ).replace(/^fn /, "function ");
  const api = await bundle(
    [
      'import { validPackedWeatherVertical } from "./packages/engine/Source/Scene/Weather/WeatherVerticalField.ts";',
      'import { validPackedWeatherCloudLayers } from "./packages/engine/Source/Scene/Weather/WeatherCloudLayers.ts";',
      "const WEATHER_TEX_W=1440, WEATHER_TEX_H=721, CLOUD_TEMPORAL_RESET_RESOURCE=2;",
      "const GPUTextureUsage={TEXTURE_BINDING:1,COPY_DST:2};",
      "function verifyCloudMutationLease() {}",
      "function destroyCloudGpuResource(context, texture) {texture.destroy();context.retired++;}",
      "function requestCloudWeatherPreparation(context, cache) {cache.preparing=true;}",
      source,
      "export {ensureWeatherView};",
    ].join("\n"),
  );
  const writes = [],
    textures = [],
    context = { retired: 0 };
  const device = {
    queue: {
      writeTexture(...args) {
        writes.push(args);
      },
    },
    createTexture(description) {
      const value = {
        description,
        destroyed: false,
        createView() {
          return { texture: value };
        },
        destroy() {
          value.destroyed = true;
        },
      };
      textures.push(value);
      return value;
    },
  };
  const cache = {
    weatherTexture: null,
    weatherTextureLayers: 0,
    weatherVertical: undefined,
    observability: {
      weatherCacheHits: 0,
      weatherCacheMisses: 0,
      weatherUploads: 0,
      weatherUploadBytes: 0,
    },
    temporalHistoryPendingResetReasons: 0,
  };
  const bytes = new Uint8Array(1440 * 721 * 4),
    plane = { bytes: bytes.slice(), minimumBase: 1000, maximumTop: 9000 };
  const view = api.ensureWeatherView(
    context,
    device,
    cache,
    true,
    bytes,
    1,
    {},
    false,
    undefined,
    1,
    plane,
  );
  assert.equal(view.texture.description.size.depthOrArrayLayers, 2);
  assert.equal(cache.weatherVertical, plane);
  assert.equal(cache.observability.weatherLiveBytes, bytes.length * 2);
  assert.equal(writes.at(-1)[0].origin.z, 1);
  assert.equal(writes.at(-1)[1], plane.bytes);
  const count = writes.length;
  assert.equal(
    api.ensureWeatherView(
      context,
      device,
      cache,
      true,
      bytes,
      2,
      {},
      false,
      undefined,
      1,
      plane,
    ),
    view,
  );
  assert.equal(writes.length, count);
  assert.equal(
    api.ensureWeatherView(context, device, cache, true, null, 3, {}, true),
    view,
  );
  assert.equal(cache.weatherVertical, plane);
  const fallback = api.ensureWeatherView(
    context,
    device,
    cache,
    true,
    bytes,
    4,
    {},
    false,
    undefined,
    1,
  );
  assert.equal(fallback.texture.description.size.depthOrArrayLayers, 1);
  assert.equal(cache.weatherVertical, undefined);
  assert.equal(context.retired, 1);
  assert.equal(view.texture.destroyed, true);
});

test("previous weather resources change vertical layouts atomically and reuse complete publications", async () => {
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, COPY_DST: 2 };
  const { CloudWeatherTransitionResources } = await bundle(
    'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudWeatherTransition.ts";',
  );
  const textures = [],
    writes = [];
  const device = {
    queue: {
      writeTexture(...args) {
        writes.push(args);
      },
    },
    createTexture(description) {
      const value = {
        description,
        createView() {
          return { texture: value };
        },
        destroy() {
          value.dead = true;
        },
      };
      textures.push(value);
      return value;
    },
  };
  const resources = new CloudWeatherTransitionResources();
  const source = {
    width: 4,
    height: 3,
    bytes: new Uint8Array(48),
    vertical: { bytes: new Uint8Array(48), minimumBase: 500, maximumTop: 8000 },
  };
  const a = resources.prepareWeather(device, source, true);
  assert.equal(textures[0].description.size[2], 2);
  assert.equal(writes.length, 2);
  assert.equal(resources.prepareWeather(device, source, true), a);
  assert.equal(writes.length, 2);
  const b = resources.prepareWeather(device, source, false);
  assert.notEqual(a, b);
  assert.equal(textures[0].dead, true);
  assert.equal(textures[1].description.size[2], 1);
  resources.destroy();
  assert.equal(textures[1].dead, true);
});
