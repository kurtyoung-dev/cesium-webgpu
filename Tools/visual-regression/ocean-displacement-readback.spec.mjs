// ocean-displacement-readback.spec.mjs - lane LINDISSE (Zimrahin). Pure Node: no browser, no GPU.
//
// @purpose Exercises ocean-displacement-readback.mjs in Node over a fake viewer and a fake GPUDevice whose compute dispatch copies a known texture into the storage buffer: the readback's bytes, hash and statistics, the compute-shader path it takes, every unavailable path's reason, the comparison and the kernel-identity verdict, each with an inertness mutant.
// @status ACTIVE
//
// The expected hash and statistics are derived here from the known texture
// data with node:crypto, not from the module under test. The fake device
// stands in for the GPU only at the WebGPU API boundary; what it cannot show
// (that the real WGSL compiles and binds an rgba16float texture) is for the
// Edge job.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { importMutated } from "./lib/import-mutated.mjs";
import {
  OCEAN_DISPLACEMENT_ACCESSOR,
  compareDisplacementReadbacks,
  kernelIdentityVerdict,
  keepValuesOutOfReport,
  pageReadOceanDisplacement,
  readOceanDisplacement,
} from "./lib/ocean-displacement-readback.mjs";

const MODULE = fileURLToPath(
  new URL("./lib/ocean-displacement-readback.mjs", import.meta.url),
);

const USAGE = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };
const MAP_MODE = { READ: 1 };

function patternData(width, height) {
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = ((i % 17) - 8) / 4;
  }
  return data;
}

function sha256Hex(floats) {
  return createHash("sha256")
    .update(Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength))
    .digest("hex");
}

// A page: a viewer whose ocean primitive carries an OceanCache-shaped state,
// and a device that executes the readback's compute copy over `data`.
function makeWorld(options = {}) {
  const {
    width = 8,
    height = 8,
    format = "rgba16float",
    kernel = "stockham",
    frameNumber = 5,
    ready = true,
    failed = false,
    validationError = null,
    mapError = null,
    renderError = null,
    data = patternData(width, height),
  } = options;
  const log = {
    renders: [],
    scopes: [],
    pops: 0,
    modules: [],
    pipelines: [],
    dispatches: [],
    buffers: [],
    rafs: 0,
  };
  const texture = {
    format,
    width,
    height,
    sampleCount: 1,
    data,
    createView() {
      return { texture };
    },
  };
  const device = {
    pushErrorScope(filter) {
      log.scopes.push(filter);
    },
    async popErrorScope() {
      log.pops++;
      return validationError;
    },
    createShaderModule(descriptor) {
      log.modules.push(descriptor);
      return { descriptor };
    },
    createComputePipeline(descriptor) {
      log.pipelines.push(descriptor);
      return { getBindGroupLayout: (index) => ({ index }) };
    },
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        destroyed: false,
        data: null,
        destroy() {
          this.destroyed = true;
        },
        async mapAsync(mode) {
          assert.equal(mode, MAP_MODE.READ);
          if (mapError) {
            throw new Error(mapError);
          }
        },
        getMappedRange() {
          return this.data.buffer.slice(0);
        },
        unmap() {},
      };
      log.buffers.push(buffer);
      return buffer;
    },
    createBindGroup: (descriptor) => descriptor,
    createCommandEncoder() {
      const ops = [];
      let bound = null;
      return {
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup(index, group) {
            bound = group;
          },
          dispatchWorkgroups(x, y) {
            log.dispatches.push([x, y]);
            ops.push({ dispatch: bound });
          },
          end() {},
        }),
        copyBufferToBuffer(source, sourceOffset, target, targetOffset, size) {
          ops.push({ copy: { source, target, size } });
        },
        finish: () => ops,
      };
    },
    queue: {
      submit(commandBuffers) {
        for (const ops of commandBuffers) {
          for (const op of ops) {
            if (op.dispatch) {
              // textureLoad over the whole texture into the storage buffer.
              const [view, storage] = op.dispatch.entries;
              storage.resource.buffer.data = Float32Array.from(
                view.resource.texture.data,
              );
            } else {
              op.copy.target.data = Float32Array.from(op.copy.source.data);
            }
          }
        }
      },
    },
  };
  const cache = {
    initialized: true,
    frameNumber,
    simulationSeconds: 12.5,
    computePipelinesReady: ready,
    ...(failed ? { computePipelinesFailed: true } : {}),
    displacementTexture: texture,
  };
  const primitive = { ifftKernel: kernel, _webgpuCache: cache };
  const viewer = {
    clock: { currentTime: { iso: "2026-06-21T00:00:00Z" } },
    scene: {
      context: { isWebGPU: true, device },
      globe: { water: { ocean: { enabled: true, primitive } } },
      render(time) {
        if (renderError) {
          throw new Error(renderError);
        }
        log.renders.push(time);
      },
    },
  };
  return { viewer, device, texture, cache, primitive, log, data };
}

function install(world) {
  globalThis.viewer = world.viewer;
  globalThis.GPUBufferUsage = USAGE;
  globalThis.GPUMapMode = MAP_MODE;
  globalThis.requestAnimationFrame = (callback) => {
    if (world.log) {
      world.log.rafs++;
    }
    setImmediate(callback);
  };
}

test.afterEach(() => {
  delete globalThis.viewer;
  delete globalThis.GPUBufferUsage;
  delete globalThis.GPUMapMode;
  delete globalThis.requestAnimationFrame;
});

// The whole happy-path promise as one check a mutant can be held to.
async function assertReadsTheField(read) {
  const world = makeWorld({ kernel: "pingpong" });
  install(world);
  const record = await read({ frames: 3 });
  assert.equal(record.available, true, record.reason);
  assert.equal(record.accessor, OCEAN_DISPLACEMENT_ACCESSOR);
  assert.equal(record.format, "rgba16float");
  assert.equal(record.width, 8);
  assert.equal(record.height, 8);
  assert.equal(record.sampleCount, 1);
  assert.equal(record.kernel, "pingpong");
  assert.equal(record.frameNumber, 5);
  assert.equal(record.simulationSeconds, 12.5);
  assert.equal(record.computePipelinesReady, true);
  assert.equal(record.hash, sha256Hex(world.data));
  assert.equal(record.min, Math.min(...world.data));
  assert.equal(record.max, Math.max(...world.data));
  assert.equal(
    record.mean,
    world.data.reduce((sum, v) => sum + v, 0) / world.data.length,
  );
  assert.equal(record.nonFinite, 0);
  assert.equal(record.nonZero, world.data.filter((v) => v !== 0).length);
  assert.equal(record.values, undefined);
  // The frames were rendered at the frozen clock, one animation frame each.
  assert.equal(world.log.renders.length, 3);
  assert.ok(
    world.log.renders.every((t) => t === world.viewer.clock.currentTime),
  );
  assert.equal(world.log.rafs, 3);
  // The path: a compute pass doing textureLoad into a storage buffer, then a
  // buffer-to-buffer copy to a mappable one. No texture copy exists to call.
  assert.deepEqual(world.log.scopes, ["validation"]);
  assert.equal(world.log.pops, 1);
  assert.match(world.log.modules[0].code, /textureLoad\(src/);
  assert.match(world.log.modules[0].code, /texture_2d<f32>/);
  assert.equal(world.log.pipelines[0].layout, "auto");
  assert.deepEqual(world.log.dispatches, [[1, 1]]);
  assert.equal(world.log.buffers.length, 2);
  const [storage, mapped] = world.log.buffers;
  assert.equal(storage.size, 8 * 8 * 16);
  assert.equal(storage.usage, USAGE.STORAGE | USAGE.COPY_SRC);
  assert.equal(mapped.usage, USAGE.MAP_READ | USAGE.COPY_DST);
  assert.ok(storage.destroyed && mapped.destroyed, "both buffers destroyed");
  assert.doesNotThrow(() => JSON.stringify(record));
}

test("readback: the field comes back with its hash and statistics, through a compute copy", async () => {
  await assertReadsTheField(pageReadOceanDisplacement);
});

test("readback: the dispatch covers a texture that is not a multiple of the workgroup", async () => {
  const world = makeWorld({ width: 20, height: 12 });
  install(world);
  const record = await pageReadOceanDisplacement({ frames: 1 });
  assert.equal(record.available, true, record.reason);
  assert.deepEqual(world.log.dispatches, [[3, 2]]);
  assert.equal(world.log.buffers[0].size, 20 * 12 * 16);
  assert.equal(record.hash, sha256Hex(world.data));
});

test("readback: includeValues adds the raw field, and only then", async () => {
  const world = makeWorld();
  install(world);
  const withValues = await pageReadOceanDisplacement({
    frames: 0,
    includeValues: true,
  });
  assert.deepEqual(withValues.values, Array.from(world.data));
  assert.equal(world.log.renders.length, 0, "frames: 0 renders nothing");
});

test("readback: non-finite values are counted, left out of the statistics, and kept in the hash", async () => {
  const data = patternData(8, 8);
  data[3] = NaN;
  data[10] = Infinity;
  const world = makeWorld({ data });
  install(world);
  const record = await pageReadOceanDisplacement({ frames: 1 });
  assert.equal(record.nonFinite, 2);
  assert.ok(Number.isFinite(record.mean));
  assert.ok(Number.isFinite(record.max));
  assert.equal(record.hash, sha256Hex(data));
});

test("readback: the page function is self-contained (it runs from its source text alone)", async () => {
  const world = makeWorld();
  const sandbox = vm.createContext({
    viewer: world.viewer,
    GPUBufferUsage: USAGE,
    GPUMapMode: MAP_MODE,
    crypto: globalThis.crypto,
    requestAnimationFrame: (callback) => setImmediate(callback),
    Promise,
  });
  const source = `(${pageReadOceanDisplacement.toString()})`;
  const record = await vm.runInContext(source, sandbox)({ frames: 1 });
  assert.equal(record.available, true, record.reason);
  assert.equal(record.hash, sha256Hex(world.data));
});

// Each way the readback can be unavailable, with the reason it must give.
const UNAVAILABLE = [
  {
    name: "no viewer on the page",
    reason: /no viewer\.scene\.context/,
    setup: () => ({ noViewer: true }),
  },
  {
    name: "not a WebGPU context",
    reason: /WebGPU-only/,
    setup: (w) => void (w.viewer.scene.context.isWebGPU = false),
  },
  {
    name: "no ocean facade",
    reason: /no water\.ocean facade/,
    setup: (w) => void (w.viewer.scene.globe.water = {}),
  },
  {
    name: "no ocean primitive",
    reason: /no ocean primitive exists/,
    setup: (w) => void (w.viewer.scene.globe.water.ocean.primitive = undefined),
  },
  {
    name: "a render that throws",
    reason: /rendering 2 frames threw: render boom/,
    options: { renderError: "render boom" },
  },
  {
    name: "no _webgpuCache",
    reason: /no _webgpuCache after 2 frames/,
    setup: (w) => void (w.primitive._webgpuCache = undefined),
  },
  {
    name: "compute pipelines failed (while reading ready)",
    reason: /failed to build/,
    options: { failed: true, ready: true },
  },
  {
    name: "compute pipelines not ready",
    reason: /not ready after 2 frames/,
    options: { ready: false },
  },
  {
    name: "no simulation frame run",
    reason: /has not run a frame/,
    options: { frameNumber: 0 },
  },
  {
    name: "no displacement texture",
    reason: /no displacementTexture/,
    setup: (w) => void (w.cache.displacementTexture = null),
  },
  {
    name: "a texture that is not rgba16float",
    reason: /rgba32float, not rgba16float/,
    options: { format: "rgba32float" },
  },
  {
    name: "no device",
    reason: /exposes no device/,
    setup: (w) => void (w.viewer.scene.context.device = undefined),
  },
  {
    name: "a GPU validation error",
    reason: /GPU validation error during the readback: .*bad binding/,
    options: { validationError: new Error("bad binding") },
  },
  {
    name: "a mapAsync that rejects",
    reason: /displacement readback threw: map lost/,
    options: { mapError: "map lost" },
  },
];

async function runUnavailable(read, entry) {
  const world = makeWorld(entry.options);
  const flags = entry.setup?.(world);
  install(world);
  if (flags?.noViewer) {
    delete globalThis.viewer;
  }
  const record = await read({ frames: 2 });
  assert.equal(record.available, false, entry.name);
  assert.match(record.reason, entry.reason, entry.name);
  assert.equal(record.accessor, OCEAN_DISPLACEMENT_ACCESSOR);
  assert.equal(record.hash, null);
  assert.doesNotThrow(() => JSON.stringify(record));
  return world;
}

for (const entry of UNAVAILABLE) {
  test(`readback: unavailable - ${entry.name} says why and never throws`, async () => {
    await runUnavailable(pageReadOceanDisplacement, entry);
  });
}

test("readback: a GPU error or a failed map still pops the scope and destroys the buffers", async () => {
  for (const options of [
    { validationError: new Error("bad binding") },
    { mapError: "map lost" },
  ]) {
    const world = makeWorld(options);
    install(world);
    const record = await pageReadOceanDisplacement({ frames: 1 });
    assert.equal(record.available, false);
    assert.equal(world.log.scopes.length, 1);
    assert.equal(world.log.pops, 1, "the scope is popped exactly once");
    assert.equal(world.log.buffers.length, 2);
    assert.ok(world.log.buffers.every((b) => b.destroyed));
  }
});

test("readback: the kernel is read from the primitive even when the readback is unavailable", async () => {
  const world = makeWorld({ kernel: "pingpong", ready: false });
  install(world);
  const record = await pageReadOceanDisplacement({ frames: 0 });
  assert.equal(record.available, false);
  assert.equal(record.kernel, "pingpong");
  assert.equal(record.computePipelinesReady, false);
});

test("readback: the Node wrapper hands the page function its arguments", async () => {
  const calls = [];
  const page = {
    evaluate: async (fn, arg) => {
      calls.push({ fn, arg });
      return { available: false };
    },
  };
  await readOceanDisplacement(page);
  await readOceanDisplacement(page, { frames: 2, includeValues: true });
  assert.equal(calls[0].fn, pageReadOceanDisplacement);
  assert.deepEqual(calls[0].arg, { frames: 8, includeValues: false });
  assert.deepEqual(calls[1].arg, { frames: 2, includeValues: true });
  for (const frames of [-1, 1.5, "3", NaN]) {
    assert.throws(() => readOceanDisplacement(page, { frames }), TypeError);
  }
});

test("readback: inertness mutants - each guard made unreachable lets its scenario through and goes red", async () => {
  const guards = [
    ["if (!context.isWebGPU) {", "no WebGPU", "not a WebGPU context"],
    ["if (!ocean) {", "no facade", "no ocean facade"],
    [
      "if (primitive === undefined || primitive === null) {",
      "no primitive",
      "no ocean primitive",
    ],
    [
      'if (!cache || typeof cache !== "object") {',
      "no cache",
      "no _webgpuCache",
    ],
    [
      "if (cache.computePipelinesFailed === true) {",
      "failed",
      "compute pipelines failed (while reading ready)",
    ],
    [
      "if (cache.computePipelinesReady !== true) {",
      "not ready",
      "compute pipelines not ready",
    ],
    ["if (!(cache.frameNumber > 0)) {", "frame 0", "no simulation frame run"],
    ["if (!texture) {", "no texture", "no displacement texture"],
    [
      `if (record.format !== "rgba16float") {`,
      "format",
      "a texture that is not rgba16float",
    ],
    [
      'if (!device || typeof device.createShaderModule !== "function") {',
      "no device",
      "no device",
    ],
    ["if (validation) {", "validation", "a GPU validation error"],
  ];
  for (const [anchor, label, scenario] of guards) {
    const mutated = await importMutated(MODULE, [
      [anchor, anchor.replace(/^if \((.*)\) \{$/, "if (false && ($1)) {")],
    ]);
    const entry = UNAVAILABLE.find((e) => e.name === scenario);
    assert.ok(entry, `scenario ${scenario}`);
    // The real module passes the scenario; the mutant must not.
    await runUnavailable(pageReadOceanDisplacement, entry);
    await assert.rejects(
      runUnavailable(mutated.pageReadOceanDisplacement, entry),
      undefined,
      `mutant ${label} must fail its scenario`,
    );
  }
});

test("readback: inertness mutants - the statistics, the raw-values branch and the cleanup go red", async () => {
  const nonFinite = async (read) => {
    const data = patternData(8, 8);
    data[3] = NaN;
    install(makeWorld({ data }));
    const record = await read({ frames: 1 });
    assert.equal(record.nonFinite, 1);
    assert.ok(Number.isFinite(record.mean));
  };
  const values = async (read) => {
    install(makeWorld());
    const record = await read({ frames: 0, includeValues: true });
    assert.ok(Array.isArray(record.values), "values are returned");
    assert.equal(record.values.length, 8 * 8 * 4);
  };
  const cleanup = async (read) => {
    const world = makeWorld();
    install(world);
    await read({ frames: 0 });
    assert.ok(world.log.buffers.every((b) => b.destroyed));
  };
  const frames = async (read) => {
    const world = makeWorld();
    install(world);
    await read({ frames: 3 });
    assert.equal(world.log.renders.length, 3);
  };
  for (const [anchor, replacement, check] of [
    [
      "if (!Number.isFinite(v)) {",
      "if (false && !Number.isFinite(v)) {",
      nonFinite,
    ],
    ["if (includeValues) {", "if (false && includeValues) {", values],
    ["if (buffer) {", "if (false && buffer) {", cleanup],
    [
      "scene.render(viewer.clock.currentTime);",
      "if (false) scene.render(viewer.clock.currentTime);",
      frames,
    ],
  ]) {
    const mutated = await importMutated(MODULE, [[anchor, replacement]]);
    await check(pageReadOceanDisplacement);
    await assert.rejects(
      check(mutated.pageReadOceanDisplacement),
      (error) => error instanceof assert.AssertionError,
      `mutant ${replacement} must fail by assertion`,
    );
  }
});

// -----------------------------------------------------------------------------
// The comparison and the verdict.
// -----------------------------------------------------------------------------

function leg(overrides = {}) {
  return {
    available: true,
    format: "rgba16float",
    width: 8,
    height: 8,
    hash: "aa",
    nonZero: 40,
    kernel: "stockham",
    simulationSeconds: 3,
    ...overrides,
  };
}

function assertComparison(compare) {
  const same = compare(leg(), leg({ kernel: "pingpong" }));
  assert.deepEqual(same, {
    measured: true,
    identical: true,
    hashA: "aa",
    hashB: "aa",
    kernelA: "stockham",
    kernelB: "pingpong",
  });
  const differ = compare(leg(), leg({ hash: "bb", kernel: "pingpong" }));
  assert.equal(differ.measured, true);
  assert.equal(differ.identical, false);
  assert.equal(differ.hashB, "bb");
  const unavailable = compare(leg(), {
    available: false,
    reason: "no ocean primitive exists",
    kernel: "pingpong",
  });
  assert.equal(unavailable.measured, false);
  assert.equal(unavailable.identical, false);
  assert.match(unavailable.reason, /readback B is unavailable: no ocean/);
  assert.equal(compare(null, leg()).measured, false);
  for (const key of ["width", "height", "format"]) {
    const resized = compare(
      leg(),
      leg({ [key]: key === "format" ? "rgba32float" : 16 }),
    );
    assert.equal(resized.measured, false, key);
    assert.equal(resized.identical, false, key);
    assert.match(resized.reason, new RegExp(`differ in ${key}`));
  }
  const zero = compare(leg({ nonZero: 0 }), leg({ nonZero: 0 }));
  assert.equal(zero.measured, false);
  assert.equal(zero.identical, false);
  assert.match(zero.reason, /readback A is an all-zero field/);
  assert.equal(compare(leg(), leg({ hash: "" })).measured, false);
  // Round 2 (R3b): a wave-time mismatch, or a missing wave time, is not a
  // kernel disagreement.
  const otherTime = compare(
    leg(),
    leg({ hash: "bb", kernel: "pingpong", simulationSeconds: 3.5 }),
  );
  assert.equal(otherTime.measured, false);
  assert.equal(otherTime.identical, false);
  assert.match(otherTime.reason, /different wave times/);
  const noTime = compare(
    leg({ simulationSeconds: null }),
    leg({ kernel: "pingpong" }),
  );
  assert.equal(noTime.measured, false);
  assert.match(noTime.reason, /no wave time/);
}

test("compare: measured needs two available, same-shaped, non-zero fields; identical is hash equality", () => {
  assertComparison(compareDisplacementReadbacks);
});

test("compare: maxAbsDelta appears only when both records carry values", () => {
  const withValues = compareDisplacementReadbacks(
    leg({ values: [0, 1, 2, 3] }),
    leg({ hash: "bb", values: [0, 1.5, 2, 2] }),
  );
  assert.equal(withValues.maxAbsDelta, 1);
  const one = compareDisplacementReadbacks(leg({ values: [0] }), leg());
  assert.equal("maxAbsDelta" in one, false);
  const lengths = compareDisplacementReadbacks(
    leg({ values: [0] }),
    leg({ values: [0, 1] }),
  );
  assert.equal("maxAbsDelta" in lengths, false);
  const identical = compareDisplacementReadbacks(
    leg({ values: [1, 2] }),
    leg({ values: [1, 2] }),
  );
  assert.equal(identical.maxAbsDelta, 0);
  assert.equal(identical.differingValues, 0);
  assert.equal(withValues.differingValues, 2);
});

test("keepValuesOutOfReport: the values stay readable but leave the written JSON (round 2, R3a)", () => {
  const record = keepValuesOutOfReport(leg({ values: [0, 1] }));
  assert.deepEqual(record.values, [0, 1]);
  assert.equal("values" in JSON.parse(JSON.stringify(record)), false);
  assert.equal(
    compareDisplacementReadbacks(
      record,
      keepValuesOutOfReport(leg({ kernel: "pingpong", values: [0, 2] })),
    ).differingValues,
    1,
  );
  assert.equal(keepValuesOutOfReport(null), null);
});

function assertVerdict(verdict) {
  const pass = verdict("cell-x", leg(), leg({ kernel: "pingpong" }));
  assert.equal(pass.id, "cell-x:ifft-kernel-identity");
  assert.equal(pass.pass, true);
  assert.equal("notRun" in pass, false);
  assert.equal(pass.comparison.identical, true);

  const fail = verdict(
    "cell-x",
    leg(),
    leg({ hash: "bb", kernel: "pingpong" }),
  );
  assert.equal(fail.pass, false);
  assert.equal("notRun" in fail, false, "a measured mismatch is a fail");

  const unmeasured = verdict("cell-x", leg(), {
    available: false,
    reason: "x",
    kernel: "pingpong",
  });
  assert.equal(unmeasured.pass, false);
  assert.equal(unmeasured.notRun, true);

  const oneKernel = verdict("cell-x", leg(), leg());
  assert.equal(oneKernel.pass, false, "one kernel against itself is no pass");
  assert.equal(oneKernel.notRun, true);
  assert.match(oneKernel.comparison.reason, /two different kernels/);

  const noKernel = verdict(
    "cell-x",
    leg({ kernel: null }),
    leg({ kernel: "pingpong" }),
  );
  assert.equal(noKernel.notRun, true);
}

test("verdict: pass only for a measured, identical field from two different kernels; otherwise fail or notRun", () => {
  assertVerdict(kernelIdentityVerdict);
});

test("compare and verdict: inertness mutants - each clause made unreachable turns its check red", async () => {
  const cases = [
    [
      `if (a[key] !== b[key]) {`,
      `if (false && a[key] !== b[key]) {`,
      "compare",
    ],
    [
      `if (!(record.nonZero > 0)) {`,
      `if (false && !(record.nonZero > 0)) {`,
      "compare",
    ],
    [`identical: a.hash === b.hash,`, `identical: true,`, "compare"],
    [
      `if (a.simulationSeconds !== b.simulationSeconds) {`,
      `if (false && a.simulationSeconds !== b.simulationSeconds) {`,
      "compare",
    ],
    [
      `!Number.isFinite(a.simulationSeconds) ||`,
      `false && !Number.isFinite(a.simulationSeconds) ||`,
      "compare",
    ],
    [
      `if (!Object.is(a.values[i], b.values[i])) {`,
      `if (false && !Object.is(a.values[i], b.values[i])) {`,
      "values",
    ],
    [
      `Array.isArray(a.values) &&`,
      `false && Array.isArray(a.values) &&`,
      "values",
    ],
    [
      `if (!comparison.measured) {`,
      `if (false && !comparison.measured) {`,
      "verdict",
    ],
    [`comparison.kernelA === comparison.kernelB`, `false`, "verdict"],
    [
      `return { id, pass: comparison.identical, comparison };`,
      `return { id, pass: true, comparison };`,
      "verdict",
    ],
  ];
  for (const [anchor, replacement, kind] of cases) {
    const mutated = await importMutated(MODULE, [[anchor, replacement]]);
    const check = () => {
      if (kind === "compare") {
        assertComparison(mutated.compareDisplacementReadbacks);
      } else if (kind === "values") {
        const result = mutated.compareDisplacementReadbacks(
          leg({ values: [0, 1] }),
          leg({ hash: "bb", values: [0, 3] }),
        );
        assert.equal(result.maxAbsDelta, 2);
        assert.equal(result.differingValues, 1);
      } else {
        assertVerdict(mutated.kernelIdentityVerdict);
      }
    };
    assert.throws(
      check,
      (error) => error instanceof assert.AssertionError,
      `mutant ${replacement} must fail by assertion`,
    );
  }
});
