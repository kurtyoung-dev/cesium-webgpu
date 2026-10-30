import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const gpu = "packages/engine/Source/Renderer/WebGPU/";
const fixtures = "Tools/visual-regression/fixtures/shader-preprocessor/";
const frozen = new Map([
  ["WebGPUShaderDefines.ts", "main-defines.ts.txt"],
  ["WebGPUShaderPreprocessor.ts", "main-template-cache.ts.txt"],
  ["WebGPUShaderModuleCache.ts", "main-module-cache.ts.txt"],
  ["WebGPURenderPipelineCache.ts", "main-pipeline-cache.ts.txt"],
]);
async function load(previous) {
  const result = await build({
    stdin: {
      contents: [...frozen.keys()]
        .map((name) => 'export * from "./' + gpu + name + '";')
        .join("\n"),
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    metafile: true,
    plugins: previous
      ? [
          {
            name: "frozen-main",
            setup(builder) {
              builder.onLoad(
                {
                  filter:
                    /WebGPU(?:ShaderDefines|ShaderPreprocessor|ShaderModuleCache|RenderPipelineCache)\.ts$/,
                },
                (args) => ({
                  contents: fs.readFileSync(
                    path.join(
                      root,
                      fixtures,
                      frozen.get(path.basename(args.path)),
                    ),
                    "utf8",
                  ),
                  loader: "ts",
                }),
              );
            },
          },
        ]
      : [],
  });
  const inputs = Object.keys(result.metafile.inputs).filter(
    (input) => input !== "<stdin>",
  );
  const api = await import(
    "data:text/javascript;base64," +
      Buffer.from(result.outputFiles[0].text).toString("base64")
  );
  return { api, inputs };
}
const current = {},
  previous = {},
  inputs = [];
before(async () => {
  const loaded = await load(false);
  Object.assign(current, loaded.api);
  inputs.push(...loaded.inputs);
  Object.assign(previous, (await load(true)).api);
});
const source =
  "//>>ifdef GEODETIC_NORMAL\nnormal\n//>>else\nbase\n//>>endif\n" +
  "//>>ifdef UNDERWATER_OPTICS\nwater\n//>>else\nsurface\n//>>endif";
function device() {
  const calls = [];
  return {
    calls,
    createShaderModule(descriptor) {
      const module = { descriptor, ordinal: calls.length };
      calls.push(module);
      return module;
    },
  };
}

test("frozen registry and water-baseline oracles retain their normalized identities", () => {
  const hashes = {
    "main-defines.ts.txt":
      "485502b67039d279f7c0a3ec79cdefb9f98fb0f7bd5d6102004ceab1fb548744",
    "main-template-cache.ts.txt":
      "26390d8bb3ba79d484247ca3e66e40b9e1f0fe4a1093a854d006f38f0cf17215",
    "main-module-cache.ts.txt":
      "b4a17c1d0ce22d16ba022a03710c8261c6323a507f105dc8e4d6385cc2d7160d",
    "main-pipeline-cache.ts.txt":
      "1b1f00874659f8eb818cd03486c19657092f794af3a1e125af523051be9fc062",
  };
  for (const [name, hash] of Object.entries(hashes)) {
    assert.equal(
      crypto
        .createHash("sha256")
        .update(
          fs
            .readFileSync(path.join(root, fixtures, name), "utf8")
            .replaceAll("\r\n", "\n"),
        )
        .digest("hex"),
      hash,
      name,
    );
  }
});

test("infrastructure imports close without cloud renderers or generated shaders", () => {
  assert.deepEqual(
    inputs.map((input) => path.basename(input)).sort(),
    ["WebGPUDeviceInvalidationBus.ts", ...frozen.keys()].sort(),
  );
});
test("published flag values, source IDs and existing-entry order remain intact", () => {
  for (const name of ["ShaderDefine", "ShaderDefineHi", "ShaderSourceId"]) {
    for (const [key, value] of Object.entries(previous[name]))
      assert.equal(current[name][key], value, name + "." + key);
    assert.deepEqual(
      Object.keys(current[name]).filter((key) =>
        Object.hasOwn(previous[name], key),
      ),
      Object.keys(previous[name]),
    );
  }
  assert.equal(current.ShaderDefineHi.UNDERWATER_OPTICS, 64);
});
test("extra-word names cannot collide with lo- or hi-word namespaces", async () => {
  const file = path.join(root, gpu, "WebGPUShaderDefines.ts");
  const text = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const anchor = "export const ShaderDefineExt = Object.freeze({";
  assert.equal(text.split(anchor).length - 1, 1);
  for (const [word, name] of [
    ["ShaderDefine", "GEODETIC_NORMAL"],
    ["ShaderDefineHi", "ENHANCED_OCEAN"],
  ]) {
    assert.ok(Object.hasOwn(current[word], name));
    await assert.rejects(
      bundle({
        path: file,
        source: text,
        real: [],
        label: "extra-word-name-collision",
        mutate: (input) =>
          input.replace(
            anchor,
            () => `${anchor}\n  ${name}: 1 as ShaderDefineExtMask,`,
          ),
      }),
      {
        message: `WebGPUShaderDefines: duplicate define name "${name}" across flag words.`,
      },
    );
  }
});
test("extra-word declarations reject reserved bit 31 at module load", async () => {
  const file = path.join(root, gpu, "WebGPUShaderDefines.ts");
  const text = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const anchor = "CLOUD_WEATHER_MATERIAL: extDefineBit(0),";
  assert.equal(text.split(anchor).length - 1, 1);
  await assert.rejects(
    bundle({
      path: file,
      source: text,
      real: [],
      label: "extra-word-reserved-bit",
      mutate: (input) =>
        input.replace(anchor, "CLOUD_WEATHER_MATERIAL: extDefineBit(31),"),
    }),
    {
      name: "RangeError",
      message:
        "ShaderDefineExt bits must use bit indices 0..30 (got 31); ext-word bit 31 is reserved",
    },
  );
});
test("hi-word declarations reject reserved bit 31 at module load and mutant R4c (> 30 -> > 31) is caught", async () => {
  const file = path.join(root, gpu, "WebGPUShaderDefines.ts");
  const text = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const anchor = "HI_WORD_PROBE: hiDefineBit(0),";
  const guardAnchor =
    "function hiDefineBit(bitIndex: number): ShaderDefineHiMask {\n  if (!Number.isInteger(bitIndex) || bitIndex < 0 || bitIndex > 30) {";
  assert.equal(text.split(anchor).length - 1, 1);
  assert.equal(text.split(guardAnchor).length - 1, 1);
  await assert.rejects(
    bundle({
      path: file,
      source: text,
      real: [],
      label: "hi-word-reserved-bit-31",
      mutate: (input) =>
        input.replace(anchor, "HI_WORD_PROBE: hiDefineBit(31),"),
    }),
    {
      name: "RangeError",
      message:
        "ShaderDefineHi bits must use bit indices 0..30 (got 31); hi-word bit 31 is reserved",
    },
  );
  // Mutant R4c: relaxing `bitIndex > 30` to `bitIndex > 31` allows bit 31 to load, which would fail the rejection assertion above.
  const relaxed = await bundle({
    path: file,
    source: text,
    real: [],
    label: "hi-word-reserved-bit-31-mutant-r4c",
    mutate: (input) =>
      input
        .replace(
          guardAnchor,
          "function hiDefineBit(bitIndex: number): ShaderDefineHiMask {\n  if (!Number.isInteger(bitIndex) || bitIndex < 0 || bitIndex > 31) {",
        )
        .replace(anchor, "HI_WORD_PROBE: hiDefineBit(31),"),
  });
  assert.equal(relaxed.ShaderDefineHi.HI_WORD_PROBE, 0x80000000);
});
test("extra-word names must use the extra-word resolver", () => {
  assert.ok(Object.keys(current.ShaderDefineExt).length > 0);
  for (const [name, value] of Object.entries(current.ShaderDefineExt)) {
    assert.equal(current.resolveDefineBitExt(name), value);
    assert.throws(() => current.resolveDefineBit(name), {
      message: `WebGPUShaderDefines: "${name}" is an EXT-word define (ShaderDefineExt). Resolve it with resolveDefineBitExt.`,
    });
  }
  assert.equal(
    current.resolveDefineBitExt("UNREGISTERED_SHADER_DEFINE"),
    undefined,
  );
  assert.equal(
    current.resolveDefineBit("UNREGISTERED_SHADER_DEFINE"),
    undefined,
  );
});
test("legacy module requests preserve emitted code, admission, salts and prewarm behavior", (t) => {
  const a = device(),
    b = device();
  const oldCache = new previous.WebGPUShaderModuleCache(a),
    cache = new current.WebGPUShaderModuleCache(b);
  let requests = 0;
  for (const id of [1, previous.ShaderSourceId.EDGE_EMITTER]) {
    for (const lo of [
      0,
      ...Object.values(previous.ShaderDefine),
      -2147483648,
      0xffffffff,
    ]) {
      for (const hi of [0, ...Object.values(previous.ShaderDefineHi)])
        for (const salt of [0, 7]) {
          const args = [id, source, lo, "legacy", salt, hi];
          const old = oldCache.getOrCreate(...args),
            next = cache.getOrCreate(...args);
          assert.equal(next.ordinal, old.ordinal);
          assert.deepEqual(next.descriptor, old.descriptor);
          assert.equal(cache.getOrCreate(...args, 0), next);
          assert.equal(cache.getOrCreate(...args), next);
          requests++;
        }
    }
  }
  const sets = [0, [0, 0], [0, previous.ShaderDefineHi.UNDERWATER_OPTICS]];
  oldCache.prewarm(2, source, sets, "warm");
  cache.prewarm(2, source, sets, "warm");
  assert.deepEqual(b.calls, a.calls);
  assert.equal(cache.size(), oldCache.size());
  cache.destroy();
  oldCache.destroy();
  assert.equal(cache.size(), 0);
  assert.deepEqual(
    cache.getOrCreate(1, source, 0, "after"),
    oldCache.getOrCreate(1, source, 0, "after"),
  );
  t.diagnostic(JSON.stringify({ requests, nativeModuleCalls: b.calls.length }));
});
test("legacy invalid module requests preserve exact rejection messages", () => {
  const before = new previous.WebGPUShaderModuleCache(device()),
    after = new current.WebGPUShaderModuleCache(device());
  const message = (run) => {
    try {
      run();
    } catch (error) {
      return error.message;
    }
    assert.fail("must reject invalid request");
  };
  for (const [index, values] of [
    [0, [-1, 256, NaN, 1.5]],
    [2, [-2147483649, 0x100000000, NaN, 0.5]],
    [5, [-1, 0x80000000, Infinity, 0.5]],
  ]) {
    for (const value of values) {
      const args = [1, source, 0, "bad", 0, 0];
      args[index] = value;
      assert.equal(
        message(() => after.getOrCreate(...args)),
        message(() => before.getOrCreate(...args)),
      );
    }
  }
});
test("extra-word modules never alias legacy or other words and are released", () => {
  const cache = new current.WebGPUShaderModuleCache(device());
  const shader =
    source +
    "\n//>>ifdef CLOUD_WEATHER_MATERIAL\nmaterial\n//>>else\nplain\n//>>endif";
  const values = new Set();
  for (const lo of [0, 1, 2 ** 30])
    for (const hi of [0, 64, 2 ** 30])
      for (const ext of [0, 1, 2 ** 30]) {
        const args = [1, shader, lo, "extra", 0, hi, ext],
          module = cache.getOrCreate(...args);
        assert.equal(cache.getOrCreate(...args), module);
        values.add(module);
        assert.equal(module.descriptor.code.endsWith("material"), ext === 1);
      }
  assert.equal(values.size, 27);
  assert.equal(cache.size(), 27);
  cache.prewarm(2, shader, [0, [0, 64], [0, 64, 1]], "warm");
  cache.prewarm(
    2,
    shader,
    [
      [0, 0, 0],
      [0, 64, 0],
      [0, 64, 1],
    ],
    "warm",
  );
  assert.equal(cache.size(), 30);
  for (const ext of [-1, 2 ** 31, NaN, Infinity, 0.5])
    assert.throws(
      () => cache.getOrCreate(1, shader, 0, "bad", 0, 0, ext),
      /bits 0..30/,
    );
  cache.destroy();
  assert.equal(cache.size(), 0);
});
test("legacy pipeline keys preserve shader, layout, render-state and define axes", (t) => {
  const before = new previous.WebGPURenderPipelineCache({}),
    after = new current.WebGPURenderPipelineCache({});
  let comparisons = 0;
  for (const module of [{}, {}])
    for (const layout of [{}, {}])
      for (const hi of [0, 64]) {
        for (const lo of [0, 1, 2 ** 30])
          for (const count of [1, 4])
            for (const format of ["rgba16float", "rgba8unorm"]) {
              const descriptor = {
                name: "legacy",
                layout,
                defines: lo,
                definesHi: hi,
                vertex: { module, entryPoint: "vertexMain", buffers: [] },
                fragment: {
                  module,
                  entryPoint: "fragmentMain",
                  targets: [{ format }],
                },
                primitive: { topology: "triangle-list", cullMode: "back" },
                depthStencil: {
                  format: "depth24plus",
                  depthWriteEnabled: true,
                  depthCompare: "less",
                },
                multisample: { count },
              };
              assert.equal(
                after.describeCacheKey(descriptor),
                before.describeCacheKey(descriptor),
              );
              assert.equal(
                after.describeCacheKey({ ...descriptor, definesExt: 0 }),
                before.describeCacheKey(descriptor),
              );
              comparisons++;
            }
      }
  t.diagnostic(JSON.stringify({ comparisons }));
});
test("extra pipeline keys preserve zero-word identity and separate bit30 from bit0", () => {
  const cache = new current.WebGPURenderPipelineCache({});
  const descriptor = {
    name: "extra",
    layout: {},
    vertex: { module: {}, entryPoint: "vertexMain" },
  };
  const plain = cache.describeCacheKey(descriptor);
  assert.equal(cache.describeCacheKey({ ...descriptor, definesExt: 0 }), plain);
  const first = cache.describeCacheKey({ ...descriptor, definesExt: 1 }),
    high = cache.describeCacheKey({ ...descriptor, definesExt: 2 ** 30 });
  assert.notEqual(first, plain);
  assert.notEqual(high, first);
  assert.match(first, /\|dfx:1$/);
  assert.match(high, /\|dfx:1073741824$/);
});
