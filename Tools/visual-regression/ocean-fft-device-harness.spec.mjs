// ocean-fft-device-harness.spec.mjs — the recording fake GPUDevice, and the real renderer over it.
// @purpose Pins lib/ocean-fft-device-harness.mjs: created textures and buffers are counted and drop out of the live set once per destroy, each compute pass logs its frame and the exact descriptor it was opened with, a compute dispatch records its pipeline, entry point, module label and code, workgroups and frame, and resolves bind-group views back to the texture objects, queue writes land in buffer bytes and texture data, the real ocean renderer run for three frames then destroyed leaves nothing live, and on a built tree (a generated shader .js beside the .wgsl) a WGSL transform still reaches the compiled module. Four inertness mutants (destroy that marks nothing, dispatch that records nothing, pass that logs nothing, routing that serves the generated .js) must turn those checks red.
// @status ACTIVE
//
// Pure Node, no GPU and no browser. Cases 1 to 3 drive `createRecordingDevice()`
// with synthetic calls; case 4 bundles the real WebGPUOceanRenderer.ts through
// `loadOceanRenderer`. Each pinned behaviour is a check function taking the
// harness module, so the mutant cases can run the same check against a copy of
// the harness with the clause made unreachable and require it to throw.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as harness from "./lib/ocean-fft-device-harness.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

const HARNESS_FILE = fileURLToPath(
  new URL("./lib/ocean-fft-device-harness.mjs", import.meta.url),
);

// A mutant loads as a data: module, which resolves no bare specifier and has no
// file import.meta.url; the two lines below are inert for createRecordingDevice
// (they serve loadOceanRenderer only), so the mutant swaps them for stand-ins.
const DATA_URL_SAFE = [
  ['import { build } from "esbuild";', "const build = null;"],
  [
    "const HERE = dirname(fileURLToPath(import.meta.url));",
    'const HERE = "/";',
  ],
];

const TEXTURE = { size: { width: 2, height: 2 }, format: "rgba32float" };
const COMPUTE_CODE = "@compute @workgroup_size(64) fn main() {}";

function checkAccounting({ createRecordingDevice }) {
  const { device, log } = createRecordingDevice();
  const a = device.createTexture({ ...TEXTURE, label: "a" });
  const b = device.createTexture({ ...TEXTURE, label: "b" });
  const buf = device.createBuffer({ label: "buf", size: 16 });
  const buf2 = device.createBuffer({ label: "buf2", size: 16 });
  assert.deepEqual(log.textures, [a, b]);
  assert.deepEqual(log.buffers, [buf, buf2]);
  assert.equal(log.liveTextures().length, 2);
  assert.equal(log.liveBuffers().length, 2);
  a.destroy();
  assert.equal(log.liveTextures().length, 1, "one destroy drops one");
  assert.deepEqual(log.liveTextures(), [b]);
  assert.equal(log.textures.length, 2, "the log keeps destroyed resources");
  buf.destroy();
  assert.equal(log.liveBuffers().length, 1);
  assert.deepEqual(log.liveBuffers(), [buf2]);
  // A second destroy is idempotent: the live count is a filter, never a counter.
  a.destroy();
  buf.destroy();
  assert.equal(log.liveTextures().length, 1);
  assert.equal(log.liveBuffers().length, 1);
  b.destroy();
  buf2.destroy();
  assert.equal(log.liveTextures().length, 0);
  assert.equal(log.liveBuffers().length, 0);
}

function checkDispatchRecording({ createRecordingDevice }) {
  const { device, log } = createRecordingDevice();
  const texture = device.createTexture({ ...TEXTURE, label: "tex" });
  const buffer = device.createBuffer({ label: "ubo", size: 16 });
  const sampler = device.createSampler({ label: "samp" });
  const module = device.createShaderModule({
    label: "evolve",
    code: COMPUTE_CODE,
  });
  const pipeline = device.createComputePipeline({
    label: "pipe",
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  const group = device.createBindGroup({
    label: "group",
    layout: {},
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: { buffer } },
      { binding: 2, resource: sampler },
    ],
  });
  log.beginFrame(7);
  const pass = device.createCommandEncoder({}).beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(5);
  pass.end();
  assert.equal(log.dispatches.length, 1);
  const [d] = log.dispatches;
  assert.equal(d.pipeline, pipeline);
  assert.equal(d.entryPoint, "main");
  assert.equal(d.moduleLabel, "evolve");
  assert.equal(d.code, COMPUTE_CODE);
  assert.deepEqual(d.workgroups, [5, 1, 1]);
  assert.equal(d.frame, 7);
  assert.equal(d.bindGroup, group);
  assert.equal(d.entries.length, 3);
  assert.equal(d.entries[0].texture, texture, "a view resolves to its texture");
  assert.equal(d.entries[1].buffer, buffer);
  assert.equal(d.entries[2].sampler, sampler);
  assert.deepEqual(
    d.entries.map((e) => e.binding),
    [0, 1, 2],
  );
  pass.dispatchWorkgroups(2, 3, 4);
  assert.deepEqual(log.dispatches[1].workgroups, [2, 3, 4]);
}

test("resource accounting: live counts drop once per destroy and a double destroy is harmless", () => {
  checkAccounting(harness);
});

function checkComputePassRecording({ createRecordingDevice }) {
  const { device, log } = createRecordingDevice();
  const descriptor = { label: "pass label", timestampWrites: { querySet: 1 } };
  log.beginFrame(4);
  device.createCommandEncoder({}).beginComputePass(descriptor);
  device.createCommandEncoder({}).beginComputePass();
  assert.equal(log.computePasses.length, 2);
  assert.equal(log.computePasses[0].frame, 4);
  assert.equal(
    log.computePasses[0].descriptor,
    descriptor,
    "the descriptor object is logged, not a copy",
  );
  assert.equal(log.computePasses[1].descriptor, undefined);
}

test("dispatch recording: pipeline, entry point, module label and code, workgroups, frame, resolved bind-group entries", () => {
  checkDispatchRecording(harness);
});

test("queue writes: writeBuffer lands at the offset, writeTexture lands in texture.data per channel layout", () => {
  const { device } = harness.createRecordingDevice();
  const buffer = device.createBuffer({ label: "b", size: 16 });
  device.queue.writeBuffer(buffer, 4, new Uint8Array([1, 2, 3]));
  assert.deepEqual(
    [...buffer.bytes],
    [0, 0, 0, 0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  device.queue.writeBuffer(buffer, 8, new Float32Array([1.5]));
  assert.equal(new Float32Array(buffer.bytes.buffer)[2], 1.5);

  const rgba = device.createTexture({ ...TEXTURE, label: "rgba" });
  const rgbaValues = Float32Array.from({ length: 16 }, (_, i) => i + 1);
  device.queue.writeTexture(
    { texture: rgba },
    rgbaValues,
    { bytesPerRow: 32 },
    { width: 2, height: 2 },
  );
  assert.deepEqual([...rgba.data], [...rgbaValues]);

  // rg32float: two channels per texel land in a four-wide texel slot.
  const rg = device.createTexture({
    size: { width: 2, height: 1 },
    format: "rg32float",
    label: "rg",
  });
  device.queue.writeTexture(
    { texture: rg },
    new Float32Array([1, 2, 3, 4]),
    { bytesPerRow: 16 },
    { width: 2, height: 1 },
  );
  assert.deepEqual([...rg.data], [1, 2, 0, 0, 3, 4, 0, 0]);

  // A format with no texel table keeps no data, and a write to it is ignored.
  const depth = device.createTexture({
    size: { width: 2, height: 2 },
    format: "depth32float",
    label: "depth",
  });
  assert.equal(depth.data, null);
  device.queue.writeTexture(
    { texture: depth },
    new Float32Array(4),
    {},
    { width: 2, height: 2 },
  );
});

test("the real renderer: three frames, a steady frame of four dispatches, and destroy leaves nothing live", async () => {
  const api = await harness.loadOceanRenderer();
  const { device, log } = harness.createRecordingDevice();
  const prim = harness.makeOceanPrimitive();
  const frames = await harness.runOceanFrames(api, device, log, prim, 3);
  assert.equal(frames.length, 3);
  assert.ok(log.textures.length > 0, "the renderer created textures");
  assert.ok(log.buffers.length > 0, "the renderer created buffers");
  assert.equal(log.liveTextures().length, log.textures.length);
  const steady = frames[2];
  assert.equal(
    steady.length,
    4,
    `the steady frame dispatches ${steady.map((x) => x.entryPoint)}`,
  );
  for (const d of steady) {
    assert.equal(d.frame, 2);
    assert.ok(d.code.length > 0 && d.moduleLabel);
  }
  api.destroyWebGPUOceanResources(prim);
  assert.equal(log.liveTextures().length, 0);
  assert.equal(log.liveBuffers().length, 0);
});

test("inertness: a destroy that marks nothing turns the accounting check red", async () => {
  const mutated = await importMutated(HARNESS_FILE, [
    ...DATA_URL_SAFE,
    ["texture.destroyed = true;", "void 0;"],
    ["buffer.destroyed = true;", "void 0;"],
  ]);
  assert.doesNotThrow(() => checkAccounting(harness));
  assert.throws(() => checkAccounting(mutated), assert.AssertionError);
});

test("inertness: a dispatch that records nothing turns the recording check red", async () => {
  const mutated = await importMutated(HARNESS_FILE, [
    ...DATA_URL_SAFE,
    ["log.dispatches.push({", "void ({"],
  ]);
  assert.doesNotThrow(() => checkDispatchRecording(harness));
  assert.throws(() => checkDispatchRecording(mutated), assert.AssertionError);
});

test("compute pass recording: each beginComputePass logs its frame and the exact descriptor handed in", () => {
  checkComputePassRecording(harness);
});

test("inertness: a compute pass that logs nothing turns the pass-recording check red", async () => {
  const mutated = await importMutated(HARNESS_FILE, [
    ...DATA_URL_SAFE,
    ["log.computePasses.push({", "void ({"],
  ]);
  assert.doesNotThrow(() => checkComputePassRecording(harness));
  assert.throws(
    () => checkComputePassRecording(mutated),
    assert.AssertionError,
  );
});

// ─────────────── built tree: a generated shader .js beside the .wgsl ───────────────
//
// `gulp build` writes `Shaders/WebGPU/<Dir>/<Name>.js` from each `.wgsl`. The
// harness must still serve the `.wgsl` through `transform`, or every WGSL
// mutant a spec requests is silently dropped on a built tree (the round-4
// landing stop: two water mutants went green there and red only in unbuilt
// clones). The check makes the built state in any tree: when the generated
// module is absent it writes one in the build's shape (the path is gitignored)
// and removes it afterwards; when present it is left untouched.

const STOCKHAM_WGSL = fileURLToPath(
  new URL(
    "../../packages/engine/Source/Shaders/WebGPU/Ocean/OceanStockhamIFFT.wgsl",
    import.meta.url,
  ),
);
const STOCKHAM_JS = STOCKHAM_WGSL.replace(/\.wgsl$/, ".js");
const MARKER = "// ocean-fft-device-harness routing marker";

async function withGeneratedStockhamModule(run) {
  const created = !fs.existsSync(STOCKHAM_JS);
  if (created) {
    const text = fs.readFileSync(STOCKHAM_WGSL, "utf8").replace(/\r\n/g, "\n");
    fs.writeFileSync(
      STOCKHAM_JS,
      `//This file is automatically rebuilt by the Cesium build process.\nexport default ${JSON.stringify(text)};\n`,
    );
  }
  try {
    return await run();
  } finally {
    if (created) {
      fs.unlinkSync(STOCKHAM_JS);
    }
  }
}

async function checkBuiltTreeRouting(h) {
  await withGeneratedStockhamModule(async () => {
    assert.ok(fs.existsSync(STOCKHAM_JS), "the generated module is present");
    const api = await h.loadOceanRenderer({
      transform: (file, text) =>
        file.endsWith("/OceanStockhamIFFT.wgsl")
          ? `${text}\n${MARKER}\n`
          : text,
    });
    const { device, log } = h.createRecordingDevice();
    const frames = await h.runOceanFrames(
      api,
      device,
      log,
      h.makeOceanPrimitive(),
      2,
    );
    const codes = frames
      .flat()
      .filter((d) => d.entryPoint.endsWith("Stockham"))
      .map((d) => d.code);
    assert.ok(codes.length > 0, "the Stockham kernel was dispatched");
    for (const code of codes) {
      assert.ok(
        code.includes(MARKER),
        "a WGSL transform must reach the compiled module with the generated .js present",
      );
    }
  });
}

test("built tree: with a generated shader .js present, a WGSL transform still reaches the compiled module", async () => {
  await checkBuiltTreeRouting(harness);
});

test("inertness: serving the generated .js when it exists (the old routing) turns the built-tree check red", async () => {
  const mutated = await importMutated(HARNESS_FILE, [
    // A data: module resolves no bare specifier and has no file URL; give the
    // copy esbuild and the harness directory explicitly so it can still bundle.
    [
      'import { build } from "esbuild";',
      `const { build } = await import(${JSON.stringify(import.meta.resolve("esbuild"))});`,
    ],
    [
      "const HERE = dirname(fileURLToPath(import.meta.url));",
      `const HERE = ${JSON.stringify(path.dirname(HARNESS_FILE))};`,
    ],
    [
      "return existsSync(asWgsl) ? asWgsl : undefined;",
      "return !existsSync(asJs) && existsSync(asWgsl) ? asWgsl : undefined;",
    ],
  ]);
  await assert.rejects(checkBuiltTreeRouting(mutated), assert.AssertionError);
});
