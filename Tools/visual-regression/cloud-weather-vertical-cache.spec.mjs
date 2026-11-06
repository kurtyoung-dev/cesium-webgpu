import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { preprocess, ShaderDefineHi as H } from "./lib/wgsl-variant.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const gpu = "packages/engine/Source/Renderer/WebGPU/";
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const built = await build({
  stdin: {
    contents:
      [
        "WebGPUCloudDensityCache",
        "WebGPUCloudDeepShadowCache",
        "WebGPUCloudDensityCacheProgram",
      ]
        .map((name) => 'export * from "./' + gpu + name + '.ts";')
        .join("\n") + "",
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "raw-cloud-shaders",
      setup(builder) {
        builder.onResolve({ filter: /Shaders\/WebGPU\/.*\.js$/ }, (args) => ({
          path: path
            .resolve(args.resolveDir, args.path)
            .replace(/\.js$/, ".wgsl"),
          namespace: "wgsl",
        }));
        builder.onLoad({ filter: /.*/, namespace: "wgsl" }, (args) => ({
          contents:
            "export default " +
            JSON.stringify(fs.readFileSync(args.path, "utf8")),
        }));
      },
    },
  ],
});
const api = await import(
  "data:text/javascript;base64," +
    Buffer.from(built.outputFiles[0].text).toString("base64")
);
globalThis.GPUBufferUsage ??= { UNIFORM: 1, COPY_DST: 2, COPY_SRC: 4 };
globalThis.GPUTextureUsage ??= {
  TEXTURE_BINDING: 1,
  STORAGE_BINDING: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
};
globalThis.GPUShaderStage ??= { COMPUTE: 4 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deviceFixture() {
  const record = { textures: [], textureWrites: [], submits: 0 };
  const pipeline = {
    getBindGroupLayout() {
      return {};
    },
  };
  const device = {
    createShaderModule: (value) => value,
    createSampler: (value) => value,
    createComputePipelineAsync: async () => pipeline,
    createBindGroupLayout: (value) => value,
    createPipelineLayout: (value) => value,
    createBindGroup: (value) => value,
    createBuffer: (value) => ({ ...value, destroy() {} }),
    createTexture(value) {
      const size = value.size,
        texture = {
          ...value,
          width: size[0],
          height: size[1],
          depthOrArrayLayers: size[2],
          mipLevelCount: value.mipLevelCount ?? 1,
          dimension: value.dimension ?? "2d",
          sampleCount: 1,
          createView() {
            return { texture };
          },
          destroy() {
            texture.dead = true;
          },
        };
      record.textures.push(texture);
      return texture;
    },
    createCommandEncoder() {
      return {
        copyTextureToTexture() {},
        copyBufferToBuffer() {},
        beginComputePass() {
          return {
            setPipeline() {},
            setBindGroup() {},
            dispatchWorkgroups() {},
            end() {},
          };
        },
        finish() {
          return {};
        },
      };
    },
    queue: {
      writeBuffer() {},
      submit() {
        record.submits++;
      },
      writeTexture(destination, bytes, layout, size) {
        record.textureWrites.push({ destination, bytes, layout, size });
      },
    },
  };
  return { device, record };
}
function material() {
  const data = new Float32Array(196);
  data[40] = 1500;
  data[41] = 4000;
  data[42] = 6378137;
  data[62] = 6356752;
  data[114] = 500;
  data[115] = 9500;
  data[36] = 1;
  return data;
}
const metadata = (count) => ({
  bytes: new Uint8Array(count * 4),
  minimumBase: 500,
  maximumTop: 9500,
});
function inputs() {
  return {
    weather: {},
    weatherSampler: {},
    shape: {},
    detail: {},
    noiseSampler: {},
    weatherBytes: new Uint8Array(128),
    weatherVersion: 1,
    verticalWeather: true,
    weatherVertical: metadata(32),
  };
}
function assembled() {
  const relative = gpu + "WebGPUProceduralCloudRenderer.ts",
    source = read(relative);
  const imports = new Map(
    [
      ...source.matchAll(/import (\w+) from "([^"]+\/Shaders\/[^"]+\.js)";/g),
    ].map((m) => [
      m[1],
      path.posix.normalize(
        path.posix.join(
          path.posix.dirname(relative),
          m[2].replace(/\.js$/, ".wgsl"),
        ),
      ),
    ]),
  );
  const line = source
    .split(/\r?\n/)
    .find((value) => value.startsWith("const PROCEDURAL_CLOUDS_SOURCE ="));
  return [...line.matchAll(/\$\{(\w+)\}/g)]
    .map((m) => read(imports.get(m[1])))
    .join("\n");
}
const functionNames = (program) =>
  new Set([...program.matchAll(/\bfn\s+(\w+)\s*\(/g)].map((m) => m[1]));

test("vertical producers share actual detailed density/profile functions and preserve disabled kernels", async () => {
  const directory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(directory, "naga_wasm_tools.js"))
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(directory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  const full = assembled();
  for (const [name, entry, flags] of [
    ["CloudDensityCache", "cloudDensityCacheBuildMain", 0],
    [
      "CloudDeepShadowCache",
      "cloudDeepShadowBuildMain",
      H.CLOUD_DENSITY_SAMPLE_CACHE | H.CLOUD_DEEP_SHADOW_CACHE,
    ],
  ]) {
    const relative =
      "packages/engine/Source/Shaders/WebGPU/Compute/" + name + ".wgsl";
    const kernel = read(relative);
    const source = api.cloudDensityComputeProgram(
      full,
      kernel,
      entry,
      flags | H.CLOUD_WEATHER_VERTICAL,
    );
    const names = functionNames(source);
    assert.ok(names.has(entry), entry);
    assert.ok(names.has("cloudRegionalProfile"));
    assert.ok(names.has("cloudVerticalMoments"));
    assert.doesNotMatch(source, /@fragment|@vertex/);
    naga.validate_wgsl(source);
    const disabled = api.cloudDensityComputeProgram(full, kernel, entry, flags);
    assert.ok(functionNames(disabled).has(entry), entry);
    assert.equal(functionNames(disabled).has("cloudRegionalProfile"), false);
    assert.equal(functionNames(disabled).has("cloudVerticalMoments"), false);
    naga.validate_wgsl(disabled);
  }
  for (const flags of [
    H.CLOUD_DENSITY_SAMPLE_CACHE | H.CLOUD_PRIMARY_DENSITY_CACHE,
    H.CLOUD_DIRECTIONAL_LIGHTING |
      H.CLOUD_DEEP_SHADOW_CACHE |
      H.CLOUD_DENSITY_SAMPLE_CACHE,
    H.CLOUD_SPATIAL_OCCUPANCY | H.CLOUD_WEATHER_VOLUME_BOUNDS,
  ])
    naga.validate_wgsl(
      preprocess(
        full,
        0,
        flags |
          H.CLOUD_WEATHER_VERTICAL |
          H.CLOUD_NOISE_BAKED_ONLY |
          H.CLOUD_MORPHOLOGY_BASE_ONLY,
      ),
    );
});

test("density cache invalidates a height-only replacement and focuses on its active envelope", async () => {
  const { device, record } = deviceFixture(),
    source = () => "";
  const state = new api.CloudDensityCache(device, source),
    data = material(),
    input = inputs();
  const camera = [6384137, 0, 0],
    wind = [0, 0, 0];
  assert.equal(state.usesSource(source), true);
  assert.equal(
    state.usesSource(() => ""),
    false,
  );
  assert.ok(
    Math.abs(
      api.cloudDensityCacheFocus(camera, data, true)[0] - (6378137 + 2750),
    ) < 1e-6,
  );
  assert.ok(
    Math.abs(api.cloudDensityCacheFocus(camera, data)[0] - (6378137 + 2750)) <
      1e-6,
  );
  state.prepare(input, data, camera, wind, true);
  await tick();
  await tick();
  for (let i = 0; i < 4; i++) state.prepare(input, data, camera, wind, true);
  assert.equal(state.ready, true);
  assert.equal(state.publications, 1);
  const submits = record.submits;
  state.prepare(input, data, camera, wind, true);
  assert.equal(record.submits, submits);
  const changed = {
    ...input,
    weatherVertical: {
      ...input.weatherVertical,
      bytes: input.weatherVertical.bytes.slice(),
    },
  };
  assert.equal(state.prepare(changed, data, camera, wind, true), false);
  assert.equal(changed.weatherVersion, input.weatherVersion);
  assert.equal(changed.weatherBytes, input.weatherBytes);
  for (let i = 0; i < 3; i++) state.prepare(changed, data, camera, wind, true);
  assert.equal(state.ready, true);
  assert.equal(state.publications, 2);
  state.destroy();
});

test("density cache focus follows the published cloud-top envelope at the camera and keeps the layer middle without one", () => {
  const data = material();
  data[64] = 1;
  data[68] = -Math.PI;
  data[69] = -Math.PI / 2;
  data[70] = 2 * Math.PI;
  data[71] = Math.PI;
  const width = 4,
    height = 2,
    bytes = new Uint8Array(width * height * 4);
  for (let texel = 0; texel < width * height; texel++) {
    bytes.set([160, 15, 224, 46], texel * 4);
  }
  const published = { bytes, minimumBase: 2000, maximumTop: 6000 };
  const size = { width, height };
  const camera = [6384137, 0, 0];
  const radiusAt = (...args) =>
    api.cloudDensityCacheFocus(camera, data, ...args)[0] - 6378137;
  assert.ok(Math.abs(radiusAt(true, published, size) - 4000) < 1e-6);
  assert.ok(Math.abs(radiusAt(false, published, size) - 2750) < 1e-6);
  assert.ok(Math.abs(radiusAt(true, undefined, size) - 2750) < 1e-6);
  assert.ok(Math.abs(radiusAt(true, published) - 2750) < 1e-6);
});

test("deep-shadow publication invalidates independently changed height metadata", async () => {
  const { device } = deviceFixture(),
    source = () => "";
  const state = new api.CloudDeepShadowCache(device, source),
    data = material(),
    input = inputs();
  const options = { cloudDeepShadowSize: 32, cloudDeepShadowRowsPerFrame: 32 };
  const camera = [6384137, 0, 0],
    wind = [0, 0, 0];
  assert.equal(state.usesSource(source), true);
  state.prepare(input, data, camera, wind, true, options);
  await tick();
  await tick();
  assert.equal(state.prepare(input, data, camera, wind, true, options), true);
  assert.equal(state.publications, 1);
  const changed = {
    ...input,
    weatherVertical: {
      ...input.weatherVertical,
      bytes: input.weatherVertical.bytes.slice(),
    },
  };
  assert.equal(state.prepare(changed, data, camera, wind, true, options), true);
  assert.equal(state.publications, 2);
  state.destroy();
});
