import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  preprocess,
  readEngineShader,
  ShaderDefineHi as H,
} from "./lib/wgsl-variant.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const result = await build({
  stdin: {
    contents:
      'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudSpatialOccupancy.ts";',
    resolveDir: root,
    loader: "js",
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
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
const camera = [6378240.25, 0.25, -0.25];
const tick = () => new Promise((resolve) => setImmediate(resolve));
globalThis.GPUTextureUsage ??= {
  STORAGE_BINDING: 1,
  TEXTURE_BINDING: 2,
  COPY_SRC: 4,
};
globalThis.GPUBufferUsage ??= { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 };

function recordingDevice({ deferred = false } = {}) {
  const record = {
    textures: [],
    buffers: [],
    passes: [],
    submits: [],
    writes: [],
    pending: [],
    failSubmit: false,
  };
  const pipeline = () => ({ getBindGroupLayout: () => ({}) });
  const texture = (descriptor) => {
    const size = descriptor.size;
    const value = {
      ...descriptor,
      width: size[0] ?? size.width,
      height: size[1] ?? size.height,
      depthOrArrayLayers: size[2] ?? size.depthOrArrayLayers,
      destroyed: false,
      createView(options) {
        return { texture: value, options };
      },
      destroy() {
        value.destroyed = true;
      },
    };
    return value;
  };
  const device = {
    createShaderModule: (descriptor) => descriptor,
    createComputePipelineAsync: () =>
      deferred
        ? new Promise((resolve) =>
            record.pending.push(() => resolve(pipeline())),
          )
        : Promise.resolve(pipeline()),
    createTexture(descriptor) {
      const value = texture(descriptor);
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
        const pass = { descriptor, dispatch: null };
        record.passes.push(pass);
        return {
          setPipeline() {},
          setBindGroup() {},
          end() {},
          dispatchWorkgroups(...args) {
            pass.dispatch = args;
          },
        };
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(buffer, offset, data) {
        const bytes = new Uint8Array(
          data.buffer ?? data,
          data.byteOffset ?? 0,
          data.byteLength,
        ).slice();
        record.writes.push({ buffer, offset, bytes });
      },
      submit(commands) {
        if (record.failSubmit) {
          throw new Error("injected submit failure");
        }
        record.submits.push(commands);
      },
    },
  };
  const cube = (size) =>
    texture({ size: [size, size, size], format: "rgba8unorm" });
  return {
    device,
    record,
    source: { shape: cube(128), detail: cube(32), sampler: {} },
  };
}

test("toroidal planning retains exact overlapping pages, including negative coordinates", () => {
  const minimum = [-12, -3, 8],
    resident = new Map();
  const pages = api.planCloudOccupancyPages(minimum, resident);
  assert.equal(pages.length, 512);
  assert.equal(new Set(pages.map((page) => page.join(","))).size, 512);
  for (const page of pages) {
    const p = page.map((value) => ((value % 8) + 8) % 8);
    resident.set(p[0] + 8 * (p[1] + 8 * p[2]), page.join(","));
  }
  assert.equal(api.planCloudOccupancyPages(minimum, resident).length, 0);
  assert.equal(api.planCloudOccupancyPages([-11, -3, 8], resident).length, 64);
  assert.equal(
    api.planCloudOccupancyPages([-11, -2, 9], resident).length,
    512 - 7 ** 3,
  );
  assert.equal(api.planCloudOccupancyPages([-4, -3, 8], resident).length, 512);
});

test("OFF allocates nothing; bounded refresh fills and reuses the grid during movement", async () => {
  const { device, record, source } = recordingDevice();
  const state = new api.CloudSpatialOccupancy(device);
  assert.equal(state.prepare(source, camera, 0.6, false), false);
  assert.equal(record.textures.length, 0);
  assert.equal(record.buffers.length, 0);
  assert.equal(state.prepare(source, camera, 0.6, true), false);
  assert.equal(state.pending, true);
  await tick();
  const labels = [];
  const context = {
    withComputePassTimestamps(descriptor) {
      labels.push(descriptor.label);
      return descriptor;
    },
  };
  assert.equal(state.prepare(source, camera, 0.6, true, 2, context), true);
  assert.equal(state.refreshedCells, 128);
  assert.equal(state.readyCells, 128);
  assert.equal(state.producerPasses, 7);
  assert.ok(labels.includes("Cloud occupancy refresh"));
  assert.ok(labels.includes("Cloud occupancy parent bounds"));
  for (let i = 0; i < 255; i++) {
    state.prepare(source, camera, 0.6, true);
  }
  assert.equal(state.readyCells, 32 ** 3);
  const submissions = record.submits.length;
  state.prepare(
    source,
    camera.map((value, i) => value + (i === 0 ? 10 : 0)),
    0.6,
    true,
  );
  assert.equal(state.refreshedCells, 0);
  assert.equal(record.submits.length, submissions);
  state.prepare(
    source,
    camera.map((value, i) => value + (i === 0 ? 256 : 0)),
    0.6,
    true,
  );
  assert.equal(state.readyCells, (448 + 2) * 64);
  assert.equal(state.refreshedCells, 128);
  const query = record.writes
    .filter((write) => write.buffer === state.uniform)
    .at(-1);
  assert.ok(
    Array.from(new Float32Array(query.bytes.buffer).slice(0, 3)).every(
      (value) => Math.abs(value) < 2048,
    ),
  );
  assert.equal(new Uint32Array(query.bytes.buffer)[7], 1);
  state.destroy();
  assert.ok(record.textures.every((value) => value.destroyed));
  assert.ok(record.buffers.every((value) => value.destroyed));
});

test("destroying a pending preparation cannot publish or allocate obsolete resources", async () => {
  const { device, record, source } = recordingDevice({ deferred: true });
  const state = new api.CloudSpatialOccupancy(device);
  state.prepare(source, camera, 0.6, true);
  state.destroy();
  for (const resolve of record.pending) {
    resolve();
  }
  await tick();
  assert.equal(state.resources, null);
  assert.equal(state.pending, false);
  assert.equal(record.textures.length, 0);
});

test("failed submission clears residency and query admission before recovery", async () => {
  const { device, record, source } = recordingDevice();
  const state = new api.CloudSpatialOccupancy(device);
  state.prepare(source, camera, 0.6, true);
  await tick();
  record.failSubmit = true;
  assert.equal(state.prepare(source, camera, 0.6, true), false);
  assert.equal(state.failed, true);
  assert.equal(state.readyCells, 0);
  const query = record.writes
    .filter((write) => write.buffer === state.uniform)
    .at(-1);
  assert.equal(new Uint32Array(query.bytes.buffer)[7], 0);
  record.failSubmit = false;
  state.prepare(source, camera, 0.6, false);
  assert.equal(state.prepare(source, camera, 0.6, true), true);
  assert.equal(state.readyCells, 128);
  state.destroy();
});

test("compute sources and actual selected march recipes validate in Naga", async () => {
  const directory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(directory, "naga_wasm_tools.js"))
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(directory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  const read = (rel) => readEngineShader(rel);
  const domain = readEngineShader(
    "Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
  );
  const query = readEngineShader(
    "Shaders/WebGPU/Environment/CloudNoiseBoundsQuery.wgsl",
  );
  for (const [name, source] of [
    [
      "noise min/max",
      readEngineShader("Shaders/WebGPU/Compute/CloudNoiseBounds.wgsl"),
    ],
    [
      "spatial bounds",
      domain +
        "\n" +
        query +
        "\n" +
        readEngineShader("Shaders/WebGPU/Compute/CloudSpatialOccupancy.wgsl"),
    ],
  ]) {
    assert.doesNotThrow(() => naga.validate_wgsl(source), name);
  }
  const renderer = read("Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts");
  const imports = new Map(
    [
      ...renderer.matchAll(
        /import\s+(\w+)\s+from\s+"([^"]*\/Shaders\/WebGPU\/[^"]+)\.js";/g,
      ),
    ].map((match) => [
      match[1],
      path.resolve(
        root,
        "packages/engine/Source/Renderer/WebGPU",
        match[2] + ".wgsl",
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
  const composed = expression
    .replace(/\$\{(\w+)\}/g, (_, name) =>
      fs.readFileSync(imports.get(name), "utf8"),
    )
    .replaceAll("\\n", "\n");
  const base = H.CLOUD_NOISE_BAKED_ONLY | H.CLOUD_MORPHOLOGY_BASE_ONLY;
  for (const flags of [
    base,
    base | H.CLOUD_SPATIAL_OCCUPANCY,
    base |
      H.CLOUD_SPATIAL_OCCUPANCY |
      H.CLOUD_PRIMARY_REUSE |
      H.CLOUD_MARCH_EMIT_RECONSTRUCTION,
  ]) {
    assert.doesNotThrow(
      () => naga.validate_wgsl(preprocess(composed, 0, flags)),
      "selected flags " + flags,
    );
  }
});
