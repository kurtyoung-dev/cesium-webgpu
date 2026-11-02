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
import { compileFunction, stripComments, vec } from "./lib/wgsl-mini-eval.mjs";
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
test("shipped primary lookup leaves coarse/near support direct and scales only fine integration support", () => {
  const source = stripComments(
    readEngineShader("Shaders/WebGPU/Environment/CloudPrimaryDensity.wgsl"),
  );
  const frame = { control: { x: 32, y: 512, z: 256, w: 1 } },
    calls = [];
  let density = vec(0.2, 1);
  const sample = compileFunction(source, "cloudPrimaryDensityAt", {
    cloudDensityCacheFrame: frame,
    __functions: {
      cloudCachedDensity(...args) {
        calls.push(args);
        return density;
      },
    },
  });
  const point = vec(0, 0, 0);
  assert.equal(sample(point, 1500, 4000, 4, 256, 0.5, 2000, false).y, 0);
  assert.equal(sample(point, 1500, 4000, 4, 256, 0.5, 512, true).y, 0);
  assert.equal(calls.length, 0);
  assert.equal(sample(point, 1500, 4000, 4, 256, 0.5, 768, true).y, 1);
  assert.equal(calls.at(-1)[3], 256);
  assert.equal(sample(point, 1500, 4000, 512, 128, 0.5, 768, true).y, 1);
  assert.equal(calls.at(-1)[3], 512);
  assert.ok(
    Math.abs(sample(point, 1500, 4000, 4, 256, 0.5, 640, true).y - 0.5) < 1e-10,
  );
  frame.control = { x: 32, y: 512, z: 256, w: 0.25 };
  assert.equal(sample(point, 1500, 4000, 4, 256, 0.5, 1000, true).y, 0.25);
  density = vec(0, 0);
  assert.equal(sample(point, 1500, 4000, 4, 256, 0.5, 1000, true).y, 0);
  frame.control = { x: 32, y: 512, z: 256, w: 0 };
  const count = calls.length;
  assert.equal(sample(point, 1500, 4000, 4, 256, 0.5, 1000, true).y, 0);
  assert.equal(calls.length, count);
});
test("primary range and strength occupy spare query slots without rebuilding or reallocating density", async () => {
  const { state, inputs, data, record } = fixture();
  state.prepare(inputs, data, camera, wind, true);
  await tick();
  for (let i = 0; i < 4; i++) state.prepare(inputs, data, camera, wind, true);
  assert.equal(state.ready, true);
  const view = state.view,
    publications = state.publications,
    submits = record.submits;
  const query = () => {
    const bytes = record.writes
      .filter((x) => x.buffer === state.uniform && x.offset === 0)
      .at(-1).bytes;
    return new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4,
    );
  };
  assert.deepEqual(Array.from(query().slice(9, 12)), [0, 0, 0]);
  assert.equal(
    state.prepare(inputs, data, camera, wind, true, {
      cloudPrimaryDensityCache: true,
      cloudPrimaryDensityMinDistance: 128,
      cloudPrimaryDensityStrength: 0.5,
    }),
    true,
  );
  assert.deepEqual(Array.from(query().slice(9, 12)), [128, 256, 0.5]);
  assert.equal(state.view, view);
  assert.equal(state.publications, publications);
  assert.equal(record.submits, submits);
  state.prepare(inputs, data, camera, wind, true, {
    cloudPrimaryDensityCache: true,
    cloudPrimaryDensityMinDistance: Infinity,
    cloudPrimaryDensityStrength: NaN,
  });
  assert.deepEqual(Array.from(query().slice(9, 12)), [512, 256, 0]);
  state.prepare(inputs, data, camera, wind, true, {
    cloudPrimaryDensityCache: false,
  });
  assert.deepEqual(Array.from(query().slice(9, 12)), [0, 0, 0]);
  assert.equal(query().byteLength, 48);
  state.destroy();
});
test("selected primary-density recipes validate and default sources retain the existing coarse/skip and density behavior", async () => {
  const source = compose();
  const base = H.CLOUD_NOISE_BAKED_ONLY | H.CLOUD_MORPHOLOGY_BASE_ONLY;
  const directory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(directory, "naga_wasm_tools.js"))
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(directory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  for (const extra of [
    0,
    H.CLOUD_DENSITY_SAMPLE_CACHE | H.CLOUD_PRIMARY_DENSITY_CACHE,
    H.CLOUD_DENSITY_SAMPLE_CACHE |
      H.CLOUD_PRIMARY_DENSITY_CACHE |
      H.CLOUD_DIRECTIONAL_LIGHTING |
      H.CLOUD_DEEP_SHADOW_CACHE,
    H.CLOUD_DENSITY_SAMPLE_CACHE |
      H.CLOUD_PRIMARY_DENSITY_CACHE |
      H.CLOUD_PRIMARY_REUSE |
      H.CLOUD_MARCH_EMIT_RECONSTRUCTION,
  ]) {
    assert.doesNotThrow(() =>
      naga.validate_wgsl(preprocess(source, 0, base | extra)),
    );
  }
  const selected = preprocess(
    source,
    0,
    base | H.CLOUD_DENSITY_SAMPLE_CACHE | H.CLOUD_PRIMARY_DENSITY_CACHE,
  );
  assert.match(
    selected,
    /if \(primaryDensity\.y < 1\.0\) \{[\s\S]*?macroSample = cloudMacroSampleAt/,
  );
  assert.match(selected, /else \{ density = primaryDensity\.x; \}/);
  assert.doesNotMatch(preprocess(source, 0, base), /fn cloudPrimaryDensityAt/);
});
