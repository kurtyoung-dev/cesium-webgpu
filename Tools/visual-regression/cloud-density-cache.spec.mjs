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
const bundle = await build({
  stdin: {
    contents:
      'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityCache.ts"; export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityCacheProgram.ts";',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "raw-cache-shaders",
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
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
globalThis.GPUBufferUsage ??= { UNIFORM: 1, COPY_DST: 2 };
globalThis.GPUTextureUsage ??= {
  TEXTURE_BINDING: 1,
  STORAGE_BINDING: 2,
  COPY_SRC: 4,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const camera = [6380637, 0, 0],
  wind = [0, 0, 0];
function material() {
  const data = new Float32Array(196);
  data[40] = 1500;
  data[41] = 4000;
  data[42] = 6378137;
  data[62] = 6356752;
  data[43] = 0.5;
  data[46] = 0.3;
  data[74] = 13375;
  data[96] = 0.6;
  return data;
}
function fixture({ deferred = false } = {}) {
  const record = {
    textures: [],
    buffers: [],
    passes: [],
    writes: [],
    submits: 0,
    pending: [],
    failSubmit: false,
  };
  const pipeline = { getBindGroupLayout: () => ({}) };
  const device = {
    createShaderModule: (descriptor) => descriptor,
    createComputePipelineAsync: () =>
      deferred
        ? new Promise((resolve) => record.pending.push(() => resolve(pipeline)))
        : Promise.resolve(pipeline),
    createTexture(descriptor) {
      const value = {
        ...descriptor,
        destroyed: false,
        createView() {
          return { texture: value };
        },
        destroy() {
          value.destroyed = true;
        },
      };
      record.textures.push(value);
      return value;
    },
    createBuffer(descriptor) {
      const value = {
        ...descriptor,
        destroyed: false,
        destroy() {
          value.destroyed = true;
        },
      };
      record.buffers.push(value);
      return value;
    },
    createBindGroup: (descriptor) => descriptor,
    createCommandEncoder: () => ({
      beginComputePass(descriptor) {
        const pass = { descriptor };
        record.passes.push(pass);
        return {
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups(...args) {
            pass.dispatch = args;
          },
          end() {},
        };
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(buffer, offset, bytes) {
        record.writes.push({
          buffer,
          offset,
          bytes: new Uint8Array(
            bytes.buffer ?? bytes,
            bytes.byteOffset ?? 0,
            bytes.byteLength,
          ).slice(),
        });
      },
      submit() {
        if (record.failSubmit) {
          const error = new Error("injected submit failure");
          error.stack = "injected submit failure";
          throw error;
        }
        record.submits++;
      },
    },
  };
  const inputs = {
    weather: {},
    weatherSampler: {},
    shape: {},
    detail: {},
    noiseSampler: {},
    weatherBytes: new Uint8Array(16),
    weatherVersion: 1,
  };
  const state = new api.CloudDensityCache(device, () => "");
  return { device, state, inputs, record, data: material() };
}
function compose() {
  const renderer = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
    ),
    "utf8",
  );
  const imports = new Map(
    [
      ...renderer.matchAll(
        /import\s+(\w+)\s+from\s+"([^"]*\/Shaders\/WebGPU\/[^"]+)\.js";/g,
      ),
    ].map((m) => [
      m[1],
      path.resolve(
        root,
        "packages/engine/Source/Renderer/WebGPU",
        m[2] + ".wgsl",
      ),
    ]),
  );
  const backtick = String.fromCharCode(96);
  const expression = renderer.match(
    new RegExp(
      "const PROCEDURAL_CLOUDS_SOURCE = " +
        backtick +
        "([^" +
        backtick +
        "]+)" +
        backtick +
        ";",
    ),
  )[1];
  return expression
    .replace(/\$\{(\w+)\}/g, (_, name) =>
      fs.readFileSync(imports.get(name), "utf8"),
    )
    .replaceAll("\\n", "\n");
}
function functionBody(source, name) {
  const start = source.indexOf("fn " + name + "("),
    first = source.indexOf("{", start);
  assert.ok(start >= 0 && first > start);
  let depth = 1,
    end = first + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  return source
    .slice(start, end)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");
}

test("producer keeps the shipped nonlinear density functions and omits view/light/cache recursion", async (t) => {
  const full = compose(),
    source = api.cloudDensityCacheProgram(full);
  const direct = preprocess(
    full,
    0,
    H.CLOUD_NOISE_BAKED_ONLY | H.CLOUD_MORPHOLOGY_BASE_ONLY,
  );
  for (const name of [
    "cloudDensityAtCoordinates",
    "cloudMacroSampleAt",
    "cloudDensityFromMacro",
    "cloudEffectiveCoverage",
  ]) {
    assert.equal(functionBody(source, name), functionBody(direct, name));
  }
  assert.doesNotMatch(
    source,
    /fn (?:marchDeck|lightMarch|cloudCachedDensity)\s*\(/,
  );
  assert.doesNotMatch(source, /@fragment|@vertex/);
  assert.match(source, /sample < 8u/);
  assert.ok(source.length < full.length);
  const directory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(directory, "naga_wasm_tools.js"))
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(directory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() => naga.validate_wgsl(source));
  const base = H.CLOUD_NOISE_BAKED_ONLY | H.CLOUD_MORPHOLOGY_BASE_ONLY;
  for (const flags of [
    base | H.CLOUD_DENSITY_SAMPLE_CACHE,
    base |
      H.CLOUD_DENSITY_SAMPLE_CACHE |
      H.CLOUD_SPATIAL_OCCUPANCY |
      H.CLOUD_WEATHER_VOLUME_BOUNDS,
    base |
      H.CLOUD_DENSITY_SAMPLE_CACHE |
      H.CLOUD_PRIMARY_REUSE |
      H.CLOUD_MARCH_EMIT_RECONSTRUCTION,
  ]) {
    assert.doesNotThrow(() => naga.validate_wgsl(preprocess(full, 0, flags)));
  }
  t.diagnostic(
    JSON.stringify({
      fullBytes: Buffer.byteLength(full),
      producerBytes: Buffer.byteLength(source),
    }),
  );
});

test("bounded refresh publishes only a complete volume and reuses it through camera changes", async () => {
  const { state, inputs, record, data } = fixture();
  const prepare = (enabled = true, position = camera) =>
    state.prepare(inputs, data, position, wind, enabled);
  assert.equal(prepare(false), false);
  assert.equal(record.textures.length, 0);
  assert.equal(prepare(), false);
  await tick();
  const labels = [];
  for (let i = 0; i < 4; i++) {
    const ready = state.prepare(
      inputs,
      data,
      camera,
      wind,
      true,
      {},
      {
        withComputePassTimestamps(d) {
          labels.push(d.label);
          return d;
        },
      },
    );
    assert.equal(ready, i === 3);
    assert.equal(state.refreshedVoxels, 32 * 32 * 8);
  }
  assert.equal(state.publications, 1);
  assert.equal(state.needsFrame, false);
  assert.ok(labels.every((label) => label === "Cloud density cache refresh"));
  const view = state.view,
    submits = record.submits;
  data[120] = 0;
  data[124] = 300;
  data[148] = 0.2;
  assert.equal(prepare(true, [camera[0], 300, 0]), true);
  assert.equal(record.submits, submits);
  assert.equal(state.view, view);
  const query = record.writes
    .filter((x) => x.buffer === state.uniform && x.offset === 0)
    .at(-1);
  assert.equal(new Float32Array(query.bytes.buffer)[3], 1);
  assert.equal(prepare(false), false);
  assert.equal(state.producerPasses, 0);
  assert.equal(record.textures.length, 2);
  state.destroy();
  assert.ok(record.textures.every((value) => value.destroyed));
  assert.ok(record.buffers.every((value) => value.destroyed));
});

test("changed current weather and material disable stale sampling; wind tolerance is explicit", async () => {
  const { state, inputs, record, data } = fixture();
  const prepare = (offset = wind) =>
    state.prepare(inputs, data, camera, offset, true);
  prepare();
  await tick();
  for (let i = 0; i < 4; i++) prepare();
  const first = state.view;
  inputs.weatherBytes = new Uint8Array(16);
  assert.equal(prepare(), false);
  assert.equal(state.publications, 1);
  for (let i = 0; i < 3; i++) prepare();
  assert.equal(state.publications, 2);
  assert.notEqual(state.view, first);
  data[46] = 0.5;
  assert.equal(prepare(), false);
  for (let i = 0; i < 3; i++) prepare();
  assert.equal(prepare([3, 0, 0]), true);
  assert.ok(state.needsFrame);
  assert.equal(prepare([100, 0, 0]), false);
  const query = record.writes
    .filter((x) => x.buffer === state.uniform && x.offset === 0)
    .at(-1);
  assert.equal(new Float32Array(query.bytes.buffer)[3], 0);
  state.destroy();
});

test("failed submit cannot publish density; expired pending sizes and disposal cannot allocate", async () => {
  const { state, inputs, record, data } = fixture();
  state.prepare(inputs, data, camera, wind, true);
  await tick();
  record.failSubmit = true;
  assert.equal(state.prepare(inputs, data, camera, wind, true), false);
  assert.equal(state.publications, 0);
  assert.equal(state.completedSlices, 0);
  assert.equal(state.failed, true);
  state.destroy();
  const next = fixture({ deferred: true });
  next.state.prepare(next.inputs, next.data, camera, wind, true);
  await tick();
  next.state.prepare(next.inputs, next.data, camera, wind, true, {
    cloudDensityCacheSize: 64,
  });
  for (const resolve of next.record.pending) resolve();
  await tick();
  assert.equal(next.record.textures.length, 2);
  assert.ok(next.record.textures.every((texture) => texture.size[0] === 64));
  next.state.destroy();
  const abandoned = fixture({ deferred: true });
  abandoned.state.prepare(abandoned.inputs, abandoned.data, camera, wind, true);
  await tick();
  abandoned.state.destroy();
  for (const resolve of abandoned.record.pending) resolve();
  await tick();
  assert.equal(abandoned.record.textures.length, 0);
});

test("regional focus stays on the cloud shell at ground, flight, orbit, seams and poles", () => {
  const data = material(),
    target = (data[40] + data[41]) * 0.5;
  for (const lon of [-Math.PI, -1, 0, Math.PI])
    for (const lat of [-Math.PI / 2, -0.3, 0, 0.7, Math.PI / 2]) {
      for (const radius of [6379000, 6400000, 26e6]) {
        const camera = [
          Math.cos(lon) * Math.cos(lat) * radius,
          Math.sin(lon) * Math.cos(lat) * radius,
          Math.sin(lat) * radius,
        ];
        const focus = api.cloudDensityCacheFocus(camera, data);
        const residual =
          (focus[0] / (data[42] + target)) ** 2 +
          (focus[1] / (data[42] + target)) ** 2 +
          (focus[2] / (data[62] + target)) ** 2;
        assert.ok(Math.abs(residual - 1) < 1e-12);
      }
    }
});
