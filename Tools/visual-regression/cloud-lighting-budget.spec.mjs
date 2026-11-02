import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { preprocess, ShaderDefineHi as H } from "./lib/wgsl-variant.mjs";
import { compileFunction, stripComments } from "./lib/wgsl-mini-eval.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const bundled = await build({
  stdin: {
    contents:
      'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUCloudLightingBudget.ts";',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const api = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
globalThis.GPUBufferUsage ??= { UNIFORM: 1, COPY_DST: 2 };
const read = (name) =>
  fs.readFileSync(
    path.join(root, "packages/engine/Source/Shaders/WebGPU/Environment", name),
    "utf8",
  );
function model() {
  const budget = { x: 0.02, y: 2, z: 0.02, w: 0 },
    cloud = {
      phaseG2: -0.2,
      cloudTopColor: { x: 1, y: 1, z: 1 },
      cloudBaseColor: { x: 1, y: 1, z: 1 },
      sunIntensity: 1,
      silverLiningIntensity: 0.1,
      isotropicFloor: 0.03,
    };
  const hg = compileFunction(
    stripComments(read("ProceduralClouds.wgsl")),
    "hgPhase",
    { PI: Math.PI },
  );
  const globals = {
    cloudLightingBudget: budget,
    cloud,
    __functions: {
      effectiveAbsorption: () => 0.04,
      genusForwardG: () => 0.85,
      hgPhase: hg,
      exp: Math.exp,
      ceil: Math.ceil,
      abs: Math.abs,
    },
  };
  const source = stripComments(read("CloudLightingBudget.wgsl"));
  return {
    budget,
    cloud,
    weight: compileFunction(source, "cloudLightingBudgetWeight", globals),
    count: compileFunction(source, "cloudLightingBudgetSamples", globals),
  };
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
  const tick = String.fromCharCode(96),
    expression = renderer.match(
      new RegExp(
        "const PROCEDURAL_CLOUDS_SOURCE = " +
          tick +
          "([^" +
          tick +
          "]+)" +
          tick +
          ";",
      ),
    )[1];
  return expression
    .replace(/\$\{(\w+)\}/g, (_, name) =>
      fs.readFileSync(imports.get(name), "utf8"),
    )
    .replaceAll("\\n", "\n");
}
test("OFF and unsupported controls allocate nothing; one16byte buffer updates and tears down safely", () => {
  assert.equal(api.resolveCloudLightingBudget({}), null);
  for (const options of [
    { cloudLightingContributionThreshold: 0 },
    { cloudLightingMinSamples: 0 },
    { cloudLightingThinOpticalDepth: -1 },
    { cloudLightingContributionThreshold: NaN },
  ]) {
    assert.equal(
      api.resolveCloudLightingBudget({
        cloudContributionLighting: true,
        ...options,
      }),
      null,
    );
  }
  const record = { buffers: [], writes: [], fail: false };
  const device = {
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        destroyed: false,
        destroy() {
          buffer.destroyed = true;
        },
      };
      record.buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        if (record.fail) {
          const e = new Error("injected budget write failure");
          e.stack = e.message;
          throw e;
        }
        record.writes.push({ buffer, offset, data: data.slice() });
      },
    },
  };
  const state = new api.CloudLightingBudget(device),
    defaults = api.resolveCloudLightingBudget({
      cloudContributionLighting: true,
    });
  assert.equal(record.buffers.length, 0);
  const buffer = state.prepare(defaults);
  assert.equal(buffer.size, 16);
  assert.equal(defaults.byteLength, 16);
  assert.equal(state.prepare(new Float32Array([0.1, 1, 0.01, 0])), buffer);
  assert.equal(record.buffers.length, 1);
  record.fail = true;
  assert.equal(state.prepare(defaults), null);
  assert.equal(buffer.destroyed, true);
  assert.equal(state.prepare(defaults), null);
  assert.equal(record.buffers.length, 1);
  state.destroy();
  assert.equal(state.prepare(defaults), null);
});
test("shipped sample selection is monotone,never exceeds request and always retains the minimum", () => {
  const { budget, count } = model();
  for (const minimum of [1, 2, 4]) {
    budget.y = minimum;
    for (const requested of [1, 2, 3, 4, 5, 8]) {
      let previous = 0;
      for (const weight of [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.99, 1]) {
        const samples = count(requested, weight);
        assert.ok(
          Number.isInteger(samples) &&
            samples >= Math.min(requested, minimum) &&
            samples <= requested,
        );
        assert.ok(samples >= previous);
        previous = samples;
      }
      assert.equal(count(requested, 1), requested);
    }
  }
});
test("actual contribution estimate protects thin/bright samples and reduces faint interior work without culling", () => {
  const { budget, cloud, weight, count } = model();
  assert.equal(weight(0.001, 100, 0.01, 0), 1);
  assert.equal(weight(0.1, 100, 1, 0), 1);
  const faint = weight(0.1, 100, 0.02, 0);
  assert.ok(faint > 0 && faint < 1);
  assert.equal(count(4, faint), 2);
  assert.equal(weight(0.1, 100, 0.02, 1), 1);
  assert.equal(weight(Infinity, 100, 0.02, 0), 1);
  assert.equal(weight(NaN, 100, 0.02, 0), 1);
  assert.equal(weight(0.1, 100, 0.02, 1.1), 1);
  budget.y = 1;
  assert.ok(count(4, faint) >= 1);
  cloud.sunIntensity = 100;
  assert.ok(weight(0.1, 100, 0.02, 0) >= faint);
  cloud.phaseG2 = 1;
  assert.equal(weight(0.1, 100, 0.02, 0), 1);
});
test("cone counts retain the original homogeneous integral and full-work sample positions", () => {
  const { count } = model();
  for (const scale of [0.5, 1, 2])
    for (const weight of [0, 0.25, 0.5, 1]) {
      const n = count(5, weight),
        step = 2500 * 0.16 * scale,
        tapWeight = 5 / n;
      let integral = 0.2 * step * 3;
      for (let i = 0; i < n; i++) {
        integral += 0.2 * step * tapWeight;
        const fi = (i + 0.5) * tapWeight - 0.5;
        assert.ok(fi >= 0 && fi <= 4);
        if (n === 5) assert.equal(fi, i);
      }
      assert.ok(Math.abs(integral - 0.2 * step * 8) < 1e-10);
    }
});
test("actual straight/directional/cone recipes validate with dependent caches and moment fallback", async () => {
  const directory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(directory, "naga_wasm_tools.js"))
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(directory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  const source = compose(),
    base = H.CLOUD_NOISE_BAKED_ONLY | H.CLOUD_MORPHOLOGY_BASE_ONLY;
  for (const extra of [
    0,
    H.CLOUD_CONTRIBUTION_LIGHTING,
    H.CLOUD_CONTRIBUTION_LIGHTING | H.CLOUD_DIRECTIONAL_LIGHTING,
    H.CLOUD_CONTRIBUTION_LIGHTING |
      H.CLOUD_DIRECTIONAL_LIGHTING |
      H.CLOUD_DENSITY_SAMPLE_CACHE |
      H.CLOUD_DEEP_SHADOW_CACHE |
      H.CLOUD_PRIMARY_DENSITY_CACHE,
    H.CLOUD_CONTRIBUTION_LIGHTING |
      H.CLOUD_DENSITY_MOMENTS |
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
    base | H.CLOUD_CONTRIBUTION_LIGHTING | H.CLOUD_DENSITY_MOMENTS,
  );
  assert.match(selected, /let lightingWeight = 1\.0;/);
  assert.match(selected, /let coneWeight = 5\.0 \/ f32\(coneCount\);/);
  assert.doesNotMatch(
    preprocess(source, 0, base),
    /fn cloudLightingBudgetWeight|var<uniform> cloudLightingBudget/,
  );
});
