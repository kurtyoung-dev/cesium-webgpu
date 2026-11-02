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
      'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudDeepShadowCache.ts"; export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityCacheProgram.ts"; export {createCloudShadowFrame,computeCloudShadowFrame} from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudShadowFrame.ts";',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "raw-deep-shaders",
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
globalThis.GPUBufferUsage ??= { UNIFORM: 1, COPY_DST: 2, COPY_SRC: 4 };
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
  data[36] = 1;
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
    copies: [],
    writes: [],
    pending: [],
    submits: 0,
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
      copyBufferToBuffer(...args) {
        record.copies.push(args);
      },
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
      writeBuffer(buffer, offset, data) {
        record.writes.push({
          buffer,
          offset,
          bytes: new Uint8Array(
            data.buffer ?? data,
            data.byteOffset ?? 0,
            data.byteLength,
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
  const state = new api.CloudDeepShadowCache(device, () => "");
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
test("directional shell clipping executes the shipped function against independent analytic roots", () => {
  const source = stripComments(
    readEngineShader(
      "Shaders/WebGPU/Environment/CloudDirectionalLighting.wgsl",
    ),
  );
  const cloud = {
    encodedCameraHigh: vec(6356992, 0, 0),
    encodedCameraLow: vec(camera[0] - 6356992, 0, 0),
  };
  const axes = (h) => vec(6378137 + h, 6378137 + h, 6356752 + h);
  const roots = (d, hi, lo, a) => {
    const origin = [-hi.x - lo.x, -hi.y - lo.y, -hi.z - lo.z],
      direction = [d.x, d.y, d.z],
      size = [a.x, a.y, a.z];
    const A = direction.reduce((v, x, i) => v + (x / size[i]) ** 2, 0);
    const B = direction.reduce(
      (v, x, i) => v + (2 * origin[i] * x) / size[i] ** 2,
      0,
    );
    const C = origin.reduce((v, x, i) => v + (x / size[i]) ** 2, 0) - 1,
      discriminant = B * B - 4 * A * C;
    if (discriminant < 0) return { x: -1, y: -1 };
    return {
      x: (-B - Math.sqrt(discriminant)) / (2 * A),
      y: (-B + Math.sqrt(discriminant)) / (2 * A),
    };
  };
  const exit = compileFunction(source, "cloudDirectionalExit", {
    cloud,
    __functions: { cloudShellAxes: axes, rayEllipsoidIntersectRTE: roots },
  });
  assert.ok(
    Math.abs(exit(vec(0, 0, 0), vec(1, 0, 0), 1500, 4000) - 1500) < 0.00001,
  );
  assert.ok(
    Math.abs(exit(vec(0, 0, 0), vec(-1, 0, 0), 1500, 4000) - 1000) < 0.00001,
  );
  assert.ok(exit(vec(0, 0, 0), vec(0, 1, 0), 1500, 4000) > 100000);
});

test("OFF allocates nothing; complete row publication freezes one density snapshot", async () => {
  const { device, state, inputs, record, data } = fixture();
  const density = {
    texture: device.createTexture({ size: [32, 32, 32] }),
    uniform: {},
    size: 32,
    publication: 1,
  };
  inputs.density = density;
  const prepare = (enabled) =>
    state.prepare(inputs, data, camera, wind, enabled, {
      cloudDeepShadowSize: 32,
      cloudDeepShadowRowsPerFrame: 8,
    });
  assert.equal(prepare(false), false);
  assert.equal(record.textures.length, 1);
  assert.equal(record.buffers.length, 0);
  assert.equal(prepare(true), false);
  await tick();
  assert.equal(prepare(true), false);
  assert.equal(state.copiedBytes, 32 ** 3 * 8 + 48);
  assert.equal(state.producerPasses, 2);
  assert.equal(record.copies.length, 1);
  assert.equal(record.copies[0][0], density.uniform);
  inputs.density = { ...density, publication: 2, uniform: {} };
  assert.equal(prepare(true), false);
  assert.equal(prepare(true), false);
  assert.equal(prepare(true), true);
  assert.equal(state.sourceDensityPublication, 1);
  assert.equal(state.snapshotCopies, 1);
  assert.equal(record.copies.length, 1);
  assert.equal(state.completedRows, 32);
  const submissions = record.submits,
    view = state.view;
  data[120] = 0;
  data[124] = 300;
  data[148] = 0.2;
  assert.equal(
    state.prepare(inputs, data, [camera[0], 300, 0], wind, true, {
      cloudDeepShadowSize: 32,
    }),
    true,
  );
  assert.equal(record.submits, submissions);
  assert.equal(state.view, view);
  assert.equal(prepare(false), false);
  assert.equal(state.producerPasses, 0);
  state.destroy();
  assert.ok(record.buffers.every((value) => value.destroyed));
  assert.ok(
    record.textures
      .filter((value) => value !== density.texture)
      .every((value) => value.destroyed),
  );
});

test("current weather, material, wind and Sun invalidate stale shadow support", async () => {
  const { state, inputs, data } = fixture();
  const prepare = (offset) =>
    state.prepare(inputs, data, camera, offset ?? wind, true, {
      cloudDeepShadowSize: 32,
      cloudDeepShadowRowsPerFrame: 8,
    });
  prepare();
  await tick();
  for (let i = 0; i < 4; i++) prepare();
  assert.equal(state.ready, true);
  inputs.weatherBytes = new Uint8Array(16);
  assert.equal(prepare(), false);
  for (let i = 0; i < 3; i++) prepare();
  assert.equal(state.publications, 2);
  assert.equal(prepare([100, 0, 0]), false);
  data[36] = 0;
  data[37] = 1;
  assert.equal(prepare(), false);
  assert.equal(state.needsFrame, false);
  state.destroy();
});

test("failed submit cannot publish; stale pending sizes and disposal cannot allocate obsolete fields", async () => {
  const { state, inputs, record, data } = fixture();
  state.prepare(inputs, data, camera, wind, true);
  await tick();
  record.failSubmit = true;
  assert.equal(state.prepare(inputs, data, camera, wind, true), false);
  assert.equal(state.publications, 0);
  assert.equal(state.completedRows, 0);
  state.destroy();
  const pending = fixture({ deferred: true });
  pending.state.prepare(pending.inputs, pending.data, camera, wind, true);
  await tick();
  pending.state.prepare(pending.inputs, pending.data, camera, wind, true, {
    cloudDeepShadowSize: 128,
  });
  for (const resolve of pending.record.pending) resolve();
  await tick();
  assert.ok(
    pending.record.textures
      .filter((t) => t.label === "Cloud cumulative deep shadow")
      .every((t) => t.size[0] === 128),
  );
  pending.state.destroy();
  const abandoned = fixture({ deferred: true });
  abandoned.state.prepare(abandoned.inputs, abandoned.data, camera, wind, true);
  await tick();
  abandoned.state.destroy();
  for (const resolve of abandoned.record.pending) resolve();
  await tick();
  assert.equal(abandoned.record.textures.length, 0);
});

test("packed directional frames retain high/low precision and explicit row/node metadata", () => {
  for (const position of [
    [6380637, 0, 0],
    [-30000000, 50, 1000],
    [1, 1, 6370000],
  ]) {
    const frame = api.createCloudShadowFrame();
    assert.equal(
      api.computeCloudShadowFrame(
        frame,
        ...position,
        1,
        0,
        1,
        8192,
        6378137,
        6356752,
      ),
      true,
    );
    const data = api.packCloudDeepShadowFrame(frame, 16, 8, true, 128),
      bits = new Uint32Array(data.buffer);
    assert.equal(data.byteLength, 112);
    assert.equal(bits[11], 16);
    assert.equal(bits[15], 8);
    assert.equal(bits[19], 33);
    for (const [i, value] of [
      frame.centerX,
      frame.centerY,
      frame.centerZ,
    ].entries()) {
      assert.ok(Math.abs(data[i] + data[i + 4] - value) < 0.01);
    }
    assert.equal(data[3], 1);
  }
});

test("actual directional/deep-shadow recipes and selective producers validate without recursive lighting", async (t) => {
  const source = compose(),
    read = (name) =>
      fs.readFileSync(
        path.join(root, "packages/engine/Source/Shaders/WebGPU/Compute", name),
        "utf8",
      );
  const flags = H.CLOUD_DENSITY_SAMPLE_CACHE | H.CLOUD_DEEP_SHADOW_CACHE;
  const producer = api.cloudDensityComputeProgram(
    source,
    read("CloudDeepShadowCache.wgsl"),
    "cloudDeepShadowBuildMain",
    flags,
  );
  assert.doesNotMatch(
    producer,
    /fn (?:lightMarch|cloudDirectionalLight|cloudDeepShadowRead)\s*\(/,
  );
  const directory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(directory, "naga_wasm_tools.js"))
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(directory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() => naga.validate_wgsl(producer));
  assert.doesNotThrow(() =>
    naga.validate_wgsl(read("CloudDensitySnapshot.wgsl")),
  );
  const base = H.CLOUD_NOISE_BAKED_ONLY | H.CLOUD_MORPHOLOGY_BASE_ONLY;
  for (const extra of [
    0,
    H.CLOUD_DIRECTIONAL_LIGHTING,
    H.CLOUD_DIRECTIONAL_LIGHTING | flags,
    H.CLOUD_DIRECTIONAL_LIGHTING |
      flags |
      H.CLOUD_PRIMARY_REUSE |
      H.CLOUD_MARCH_EMIT_RECONSTRUCTION,
  ]) {
    assert.doesNotThrow(() =>
      naga.validate_wgsl(preprocess(source, 0, base | extra)),
    );
  }
  assert.doesNotMatch(
    preprocess(source, 0, base),
    /fn cloudDirectionalLight|fn cloudDeepShadowRead/,
  );
  t.diagnostic(
    JSON.stringify({
      fullBytes: Buffer.byteLength(source),
      producerBytes: Buffer.byteLength(producer),
    }),
  );
});
