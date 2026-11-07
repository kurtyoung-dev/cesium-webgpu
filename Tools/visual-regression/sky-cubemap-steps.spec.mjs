// sky-cubemap-steps.spec.mjs - the sky-cubemap page steps and the two-arm face comparison.
//
// @purpose Node spec for lib/sky-cubemap-steps.mjs: the REAL page functions (add the model, read the six faces of mip 0) run against a fake WebGPU world that holds a cube only when the spec gives it one and emulates the compute copy from texel data the spec supplies, so a reader that invents a value goes red; a page without the cube, a cache that never settles, a missing model and an unsupported format each answer NOT AVAILABLE naming the seam; the Node record builder computes every statistic (sha256, byte length, non-zero count) itself and keeps the bytes out of the record; the pure comparison reads IDENTICAL on equal per-face sha256, else the per-face maximum absolute delta (decoded halves for rgba16float), NOT AVAILABLE when either arm has no cube; with inertness mutants for the settled gate, the missing-cube guard, the identity rule, the per-face non-zero rule, the validation-error check and the readback shader's write layout.
// @status ACTIVE
//
// The fake device does not run WGSL. It records the shader, the bind group and
// the dispatch, and on submit it fills the storage buffer from `texel(face, x,
// y)` at the index the page's OWN shader computes: the `let i = ...;`
// expression is taken from the shader text the page function created and
// evaluated per invocation, so a shader that writes another layout (x and y
// swapped, faces interleaved) reads back other bytes and the face-order case
// goes red. The pack width (one u32 per texel for rgba8unorm, two for
// rgba16float) follows the format. A world with `validationError` answers
// that error from `popErrorScope` and writes nothing, as an invalid pass does.
// `pageSkyCubeAddModel` runs for real against a fake Cesium module served as a
// `data:` URL. What stays for Edge: the engine's real cube, its real face
// order and the real compute copy.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import * as steps from "./lib/sky-cubemap-steps.mjs";

const MODULE = fileURLToPath(
  new URL("./lib/sky-cubemap-steps.mjs", import.meta.url),
);
const SIZE = 4;

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** A texel's four bytes in the cube the spec builds: distinct per face/x/y. */
const texel8 = (face, x, y) => [face * 40 + 1, x * 16 + 2, y * 16 + 3, 255];

function expectedFace8(face) {
  const bytes = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      Buffer.from(texel8(face, x, y)).copy(bytes, (y * SIZE + x) * 4);
    }
  }
  return bytes;
}

/**
 * Run `fn` with the page globals a sky-cube page function reads, then restore.
 * `world` = {cube: {format} | null, settleAfter, texel, log}.
 */
async function withFakePage(world, fn) {
  const root = globalThis;
  const saved = {
    viewer: root.viewer,
    model: root.__skyCubeModel,
    usage: root.GPUBufferUsage,
    map: root.GPUMapMode,
    raf: root.requestAnimationFrame,
  };
  const log = world.log ?? {
    frames: 0,
    dispatches: [],
    views: [],
    code: [],
    copies: [],
  };
  world.log = log;
  const cache = world.cube
    ? {
        cubemapTexture: {
          format: world.cube.format,
          width: SIZE,
          height: SIZE,
          mipLevelCount: 3,
          createView(descriptor) {
            log.views.push(descriptor);
            return { descriptor };
          },
        },
        pendingRefresh: null,
        needsUpdate: true,
      }
    : undefined;
  const manager = { _webgpuCache: cache };
  const device = {
    createBuffer(descriptor) {
      const buffer = {
        descriptor,
        data: new Uint8Array(descriptor.size),
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
        async mapAsync() {},
        getMappedRange() {
          return this.data.buffer;
        },
        unmap() {},
      };
      (log.buffers ??= []).push(buffer);
      return buffer;
    },
    createShaderModule({ code }) {
      log.code.push(code);
      return {};
    },
    pushErrorScope(filter) {
      (log.scopes ??= []).push(`push:${filter}`);
    },
    async popErrorScope() {
      (log.scopes ??= []).push("pop");
      return world.validationError ? { message: world.validationError } : null;
    },
    createComputePipeline() {
      return { getBindGroupLayout: () => ({}) };
    },
    createBindGroup({ entries }) {
      log.entries = entries;
      return {};
    },
    createCommandEncoder() {
      const enc = {
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups: (...dims) => log.dispatches.push(dims),
          end() {},
        }),
        copyBufferToBuffer: (src, _so, dst, _do, bytes) => {
          log.copies.push(() => dst.data.set(src.data.subarray(0, bytes)));
        },
        finish: () => ({}),
      };
      return enc;
    },
    queue: {
      submit() {
        if (world.validationError) {
          return;
        }
        const out = log.entries.find((e) => e.binding === 1).resource.buffer;
        const float16 = world.cube.format === "rgba16float";
        const indexText = /let i = ([^;]+);/.exec(log.code.at(-1))?.[1];
        assert.ok(indexText, "the readback shader names its write index");
        // The index is read in the form the shader writes it,
        // `(id.A * n + id.B) * n + id.C`, with the three axes taken from the
        // text; any other form fails here rather than being guessed.
        const axes =
          /^\(id\.([xyz]) \* n \+ id\.([xyz])\) \* n \+ id\.([xyz])$/.exec(
            indexText.trim(),
          );
        assert.ok(axes, `the write index has the expected form: ${indexText}`);
        const indexOf = (id, n) =>
          (id[axes[1]] * n + id[axes[2]]) * n + id[axes[3]];
        for (let face = 0; face < 6; face++) {
          for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
              const t = world.texel(face, x, y);
              const base = indexOf({ x, y, z: face }, SIZE) * (float16 ? 8 : 4);
              for (let k = 0; k < t.length; k++) {
                if (float16) {
                  out.data[base + k * 2] = t[k] & 255;
                  out.data[base + k * 2 + 1] = t[k] >> 8;
                } else {
                  out.data[base + k] = t[k];
                }
              }
            }
          }
        }
        for (const copy of log.copies) {
          copy();
        }
      },
    },
  };
  root.viewer = {
    scene: {
      context: { device },
      initializeFrame() {},
      render() {
        log.frames++;
        if (cache && log.frames >= (world.settleAfter ?? 1)) {
          cache.needsUpdate = world.neverSettle === true;
        }
      },
    },
    clock: { currentTime: {} },
  };
  root.__skyCubeModel = world.noModel
    ? undefined
    : { _environmentMapManager: manager };
  root.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, MAP_READ: 4, COPY_DST: 8 };
  root.GPUMapMode = { READ: 1 };
  root.requestAnimationFrame = (callback) => setImmediate(() => callback(0));
  try {
    return await fn(log);
  } finally {
    root.viewer = saved.viewer;
    root.__skyCubeModel = saved.model;
    root.GPUBufferUsage = saved.usage;
    root.GPUMapMode = saved.map;
    root.requestAnimationFrame = saved.raf;
  }
}

const READ_ARGS = { maxFrames: 6, settledReads: 3 };

test("a settled rgba8unorm cube: the page function reads six faces, in face order, from a mip-0 2d-array view", async () => {
  const world = {
    cube: { format: "rgba8unorm" },
    texel: texel8,
    settleAfter: 2,
  };
  const raw = await withFakePage(world, () =>
    steps.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(raw.available, true);
  assert.equal(raw.format, "rgba8unorm");
  assert.equal(raw.size, SIZE);
  assert.equal(raw.mipLevels, 3);
  assert.equal(raw.faces.length, 6);
  for (let face = 0; face < 6; face++) {
    assert.equal(raw.faces[face].face, face);
    assert.equal(
      sha(Buffer.from(raw.faces[face].bytes, "base64")),
      sha(expectedFace8(face)),
      `face ${face} bytes are the cube's texels`,
    );
  }
  assert.deepEqual(world.log.views, [
    { dimension: "2d-array", baseMipLevel: 0, mipLevelCount: 1 },
  ]);
  assert.deepEqual(world.log.dispatches, [[1, 1, 6]]);
  assert.match(world.log.code[0], /pack4x8unorm/);
  assert.ok(world.log.frames >= 2, "rendered until the cache settled");
  assert.ok(
    world.log.buffers.every((buffer) => buffer.destroyed),
    "the probe's own buffers are destroyed",
  );
});

test("an rgba16float cube reads two words per texel through pack2x16float", async () => {
  const world = {
    cube: { format: "rgba16float" },
    texel: (face, x, y) => [face + 1, x + 2, y + 3, 4],
    settleAfter: 1,
  };
  const raw = await withFakePage(world, () =>
    steps.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(raw.available, true);
  assert.equal(raw.format, "rgba16float");
  assert.match(world.log.code[0], /pack2x16float/);
  const first = Buffer.from(raw.faces[0].bytes, "base64");
  assert.equal(first.length, SIZE * SIZE * 8);
  assert.equal(first.readUInt16LE(0), 1);
  assert.equal(first.readUInt16LE(2), 2);
});

test("a page without the cube answers NOT AVAILABLE naming the seam, after the frame budget", async () => {
  const world = { cube: null, texel: texel8 };
  const raw = await withFakePage(world, () =>
    steps.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(raw.available, false);
  assert.match(raw.reason, /NOT AVAILABLE/);
  assert.match(raw.reason, /manager\._webgpuCache\.cubemapTexture/);
  assert.match(raw.reason, /6 frames/);
  assert.equal(world.log.frames, 6);
  assert.equal(world.log.dispatches.length, 0, "no readback was attempted");
});

test("a cache that never settles is NOT AVAILABLE, not a read of a half-built cube", async () => {
  const world = {
    cube: { format: "rgba8unorm" },
    texel: texel8,
    neverSettle: true,
  };
  const raw = await withFakePage(world, () =>
    steps.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(raw.available, false);
  assert.match(raw.reason, /did not settle/);
  assert.equal(world.log.dispatches.length, 0);
});

test("no model on the page, and an unsupported cube format, each name their seam", async () => {
  const noModel = await withFakePage(
    { cube: { format: "rgba8unorm" }, texel: texel8, noModel: true },
    () => steps.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(noModel.available, false);
  assert.match(noModel.reason, /globalThis\.__skyCubeModel/);
  const format = await withFakePage(
    { cube: { format: "bgra8unorm" }, texel: texel8 },
    () => steps.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(format.available, false);
  assert.match(format.reason, /bgra8unorm/);
});

test("the record builder computes sha256, byte length and non-zero count in Node and keeps the bytes out of the record", async () => {
  const world = { cube: { format: "rgba8unorm" }, texel: texel8 };
  const raw = await withFakePage(world, () =>
    steps.pageSkyCubeReadFaces(READ_ARGS),
  );
  const written = new Map();
  const record = steps.skyCubeRecord(raw, {
    base: "E-SKY-cube-webgpu-run1",
    outputDirectory: path.join("out", "dir"),
    writeFace: (file, bytes) => written.set(file, bytes),
  });
  assert.equal(record.available, true);
  assert.equal(record.faces.length, 6);
  for (const face of record.faces) {
    const expected = expectedFace8(face.face);
    assert.equal(face.sha256, sha(expected));
    assert.equal(face.byteLength, expected.length);
    assert.equal(
      face.nonZeroBytes,
      [...expected].filter((byte) => byte !== 0).length,
    );
    assert.ok(path.isAbsolute(face.path));
    assert.ok(
      written.has(
        path.join(
          "out",
          "dir",
          `E-SKY-cube-webgpu-run1-skycube-face${face.face}.bin`,
        ),
      ),
    );
  }
  assert.ok(
    !JSON.stringify(record).includes(raw.faces[0].bytes),
    "the base64 bytes never reach the record",
  );
  assert.deepEqual(steps.skyCubeRecordVerdict(record), { pass: true });
});

test("a cube whose faces are all zero fails its own verdict; an unavailable record is NOT AVAILABLE", () => {
  const zero = {
    available: true,
    faces: Array.from({ length: 6 }, (_, face) => ({
      face,
      sha256: "z",
      byteLength: 64,
      nonZeroBytes: 0,
    })),
  };
  const verdict = steps.skyCubeRecordVerdict(zero);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /zero/);
  const missing = steps.skyCubeRecordVerdict({
    available: false,
    reason: "NOT AVAILABLE: x",
  });
  assert.equal(missing.pass, false);
  assert.equal(missing.notAvailable, true);
  assert.equal(
    steps.skyCubeRecordVerdict({ available: true, faces: [] }).pass,
    false,
  );
});

/** A record for the comparison cases, faces from `bytesOf(face)`. */
function recordOf(format, bytesOf) {
  return {
    available: true,
    format,
    size: SIZE,
    faces: Array.from({ length: 6 }, (_, face) => {
      const bytes = bytesOf(face);
      return {
        face,
        sha256: sha(bytes),
        byteLength: bytes.length,
        nonZeroBytes: 1,
        bytes,
      };
    }),
  };
}
const readFace = (_record, face) => face.bytes;

test("two arms with equal per-face sha256 compare IDENTICAL with delta 0", () => {
  const a = recordOf("rgba8unorm", expectedFace8);
  const b = recordOf("rgba8unorm", expectedFace8);
  const result = steps.compareSkyCubeRecords(a, b, { readFace });
  assert.equal(result.verdict, "IDENTICAL");
  assert.ok(result.faces.every((f) => f.identical && f.maxAbsDelta === 0));
});

test("one face that differs by 7 in one byte: DIFFERS, that face's delta 7, the others identical", () => {
  const a = recordOf("rgba8unorm", expectedFace8);
  const b = recordOf("rgba8unorm", (face) => {
    const bytes = Buffer.from(expectedFace8(face));
    if (face === 3) {
      bytes[10] += 7;
    }
    return bytes;
  });
  const result = steps.compareSkyCubeRecords(a, b, { readFace });
  assert.equal(result.verdict, "DIFFERS");
  assert.deepEqual(
    result.faces.map((f) => [f.face, f.identical, f.maxAbsDelta]),
    [
      [0, true, 0],
      [1, true, 0],
      [2, true, 0],
      [3, false, 7],
      [4, true, 0],
      [5, true, 0],
    ],
  );
});

test("rgba16float deltas are decoded halves: 0x3c00 (1.0) against 0x4000 (2.0) is 1", () => {
  const face = (value) => {
    const bytes = Buffer.alloc(SIZE * SIZE * 8);
    bytes.writeUInt16LE(value, 0);
    return bytes;
  };
  const a = recordOf("rgba16float", () => face(0x3c00));
  const b = recordOf("rgba16float", (f) => face(f === 0 ? 0x4000 : 0x3c00));
  const result = steps.compareSkyCubeRecords(a, b, { readFace });
  assert.equal(result.verdict, "DIFFERS");
  assert.equal(result.faces[0].maxAbsDelta, 1);
});

test("a face whose bytes cannot be read differs with delta null; a geometry change differs without faces", () => {
  const a = recordOf("rgba8unorm", expectedFace8);
  const b = recordOf("rgba8unorm", (face) =>
    face === 1 ? Buffer.alloc(SIZE * SIZE * 4, 9) : expectedFace8(face),
  );
  const result = steps.compareSkyCubeRecords(a, b, { readFace: () => null });
  assert.equal(result.verdict, "DIFFERS");
  assert.equal(result.faces[1].maxAbsDelta, null);
  const geometry = steps.compareSkyCubeRecords(
    a,
    { ...b, size: 8 },
    { readFace },
  );
  assert.equal(geometry.verdict, "DIFFERS");
  assert.match(geometry.reason, /geometry/);
  assert.equal(geometry.faces, undefined);
});

test("either arm without a cube makes the comparison NOT AVAILABLE with that arm's reason", () => {
  const a = recordOf("rgba8unorm", expectedFace8);
  const none = { available: false, reason: "NOT AVAILABLE: no cube (seam: s)" };
  const before = steps.compareSkyCubeRecords(none, a, { readFace });
  assert.equal(before.verdict, "NOT AVAILABLE");
  assert.match(before.reason, /^before arm: .*seam: s/);
  const after = steps.compareSkyCubeRecords(a, null, { readFace });
  assert.equal(after.verdict, "NOT AVAILABLE");
  assert.match(after.reason, /^after arm: /);
});

test("the model dial is validated in Node", () => {
  assert.equal(
    steps.skyCubeModelViolation({ url: "/a.glb", lon: 1, lat: 2, height: 0 }),
    null,
  );
  assert.match(steps.skyCubeModelViolation(null), /skyCubeModel/);
  assert.match(
    steps.skyCubeModelViolation({
      url: "http://x/a.glb",
      lon: 1,
      lat: 2,
      height: 0,
    }),
    /same-origin/,
  );
  assert.match(
    steps.skyCubeModelViolation({ url: "/a.glb", lon: "1", lat: 2, height: 0 }),
    /lon/,
  );
});

// ---------------------------------------------------------------------------
// The validation scope, the per-face rule and the model step.
// ---------------------------------------------------------------------------

/** A validation error of the probe's own pass answers NOT AVAILABLE, never six zero faces. */
async function behaviourScope(mod) {
  const world = {
    cube: { format: "rgba8unorm" },
    texel: texel8,
    validationError: "Binding size is smaller than the minimum",
  };
  const raw = await withFakePage(world, () =>
    mod.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(raw.available, false, "an invalid readback is not a read");
  assert.match(
    raw.reason,
    /^NOT AVAILABLE: GPU validation error during the face readback: Binding size/,
  );
  assert.deepEqual(world.log.scopes, ["push:validation", "pop"]);
  assert.ok(
    world.log.buffers.every((buffer) => buffer.destroyed),
    "the probe's buffers are destroyed on the error path too",
  );
  const verdict = mod.skyCubeRecordVerdict(raw);
  assert.equal(verdict.notAvailable, true, "NOT RUN, not a FAIL of the scene");
  const clean = { cube: { format: "rgba8unorm" }, texel: texel8 };
  const ok = await withFakePage(clean, () =>
    mod.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(ok.available, true);
  assert.deepEqual(clean.log.scopes, ["push:validation", "pop"]);
}

/** Every face must hold a non-zero byte: one empty face fails, naming it. */
function behaviourPerFace(mod) {
  const faces = (zeroFaces) => ({
    available: true,
    faces: Array.from({ length: 6 }, (_, face) => ({
      face,
      sha256: `s${face}`,
      byteLength: 64,
      nonZeroBytes: zeroFaces.includes(face) ? 0 : 64,
    })),
  });
  assert.equal(mod.skyCubeRecordVerdict(faces([])).pass, true);
  const one = mod.skyCubeRecordVerdict(faces([3]));
  assert.equal(one.pass, false, "one empty face fails the cube");
  assert.deepEqual(one.emptyFaces, [3]);
  assert.match(one.reason, /face\(s\) 3 hold only zero bytes/);
  const five = mod.skyCubeRecordVerdict(faces([0, 1, 2, 4, 5]));
  assert.equal(
    five.pass,
    false,
    "five empty faces fail although one is written",
  );
  assert.deepEqual(five.emptyFaces, [0, 1, 2, 4, 5]);
  assert.equal(mod.skyCubeRecordVerdict(faces([0, 1, 2, 3, 4, 5])).pass, false);
}

/** The settled gate: a cache that never settles is not read. */
async function behaviourSettled(mod) {
  const raw = await withFakePage(
    { cube: { format: "rgba8unorm" }, texel: texel8, neverSettle: true },
    () => mod.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(raw.available, false);
  assert.match(raw.reason, /did not settle/);
}

/** The missing-cube guard names its seam. */
async function behaviourMissingCube(mod) {
  const raw = await withFakePage({ cube: null, texel: texel8 }, () =>
    mod.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(raw.available, false);
  assert.match(raw.reason, /manager\._webgpuCache\.cubemapTexture/);
}

/** Equal per-face sha256 is IDENTICAL. */
function behaviourIdentity(mod) {
  const a = recordOf("rgba8unorm", expectedFace8);
  const b = recordOf("rgba8unorm", expectedFace8);
  assert.equal(
    mod.compareSkyCubeRecords(a, b, { readFace }).verdict,
    "IDENTICAL",
  );
}

/** The face read follows the shader's layout: face-major, row-major. */
async function behaviourLayout(mod) {
  const raw = await withFakePage(
    { cube: { format: "rgba8unorm" }, texel: texel8 },
    () => mod.pageSkyCubeReadFaces(READ_ARGS),
  );
  assert.equal(raw.available, true);
  for (let face = 0; face < 6; face++) {
    assert.equal(
      sha(Buffer.from(raw.faces[face].bytes, "base64")),
      sha(expectedFace8(face)),
      `face ${face} bytes are the cube's texels in row-major order`,
    );
  }
}

/** The step adds the model through the Cesium module and renders until it is ready. */
const FAKE_CESIUM = `data:text/javascript,${encodeURIComponent(`
export const Cartesian3 = { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) };
export const Transforms = { eastNorthUpToFixedFrame: (p) => ({ enu: p }) };
export const Model = {
  async fromGltfAsync(options) {
    globalThis.__fakeGltfCalls.push(options);
    return { ready: false, options };
  },
};
`)}`;
const NO_MODEL_CESIUM = `data:text/javascript,${encodeURIComponent(
  "export const Model = {};",
)}`;

async function withAddModelPage(readyAfter, fn) {
  const root = globalThis;
  const saved = {
    viewer: root.viewer,
    model: root.__skyCubeModel,
    raf: root.requestAnimationFrame,
    calls: root.__fakeGltfCalls,
  };
  const log = { added: [], frames: 0 };
  root.__fakeGltfCalls = [];
  root.viewer = {
    scene: {
      primitives: { add: (primitive) => log.added.push(primitive) },
      initializeFrame() {},
      render() {
        log.frames++;
        if (log.frames >= readyAfter && log.added[0]) {
          log.added[0].ready = true;
        }
      },
    },
    clock: { currentTime: {} },
  };
  root.requestAnimationFrame = (callback) => setImmediate(() => callback(0));
  try {
    return await fn(log, root.__fakeGltfCalls);
  } finally {
    root.viewer = saved.viewer;
    root.__skyCubeModel = saved.model;
    root.requestAnimationFrame = saved.raf;
    root.__fakeGltfCalls = saved.calls;
  }
}

const TRUCK = {
  url: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
  lon: -123.0744619,
  lat: 44.0503706,
  height: 0,
};

test("pageSkyCubeAddModel adds the rig's model through Model.fromGltfAsync and renders until it is ready", async () => {
  await withAddModelPage(3, async (log, calls) => {
    const answer = await steps.pageSkyCubeAddModel({
      moduleUrl: FAKE_CESIUM,
      model: TRUCK,
      maxFrames: 10,
    });
    assert.deepEqual(answer, { added: true, ready: true, frames: 3 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TRUCK.url);
    assert.deepEqual(calls[0].modelMatrix, {
      enu: { lon: TRUCK.lon, lat: TRUCK.lat, height: TRUCK.height },
    });
    assert.equal(log.added.length, 1, "the model is added to scene.primitives");
    assert.equal(globalThis.__skyCubeModel, log.added[0]);
  });
  await withAddModelPage(99, async () => {
    const late = await steps.pageSkyCubeAddModel({
      moduleUrl: FAKE_CESIUM,
      model: TRUCK,
      maxFrames: 4,
    });
    assert.deepEqual(late, { added: true, ready: false, frames: 4 });
  });
  await withAddModelPage(1, async () => {
    const none = await steps.pageSkyCubeAddModel({
      moduleUrl: NO_MODEL_CESIUM,
      model: TRUCK,
      maxFrames: 4,
    });
    assert.equal(none.added, false);
    assert.match(none.reason, /NOT AVAILABLE: Model\.fromGltfAsync/);
  });
});

test("a validation error of the probe's own readback is NOT AVAILABLE (NOT RUN), never six zero faces", async () => {
  await behaviourScope(steps);
});

test("every face must hold a non-zero byte: one or five empty faces fail, naming them", () => {
  behaviourPerFace(steps);
});

test("the face read follows the readback shader's own write index", async () => {
  await behaviourLayout(steps);
});

test("sky-cube-read is NOT RUN, not FAIL, when the readback had a validation error", async () => {
  const { landingVerdicts } = await import(
    new URL("./lib/landing-verdicts.mjs", import.meta.url).href
  );
  const raw = await withFakePage(
    {
      cube: { format: "rgba8unorm" },
      texel: texel8,
      validationError: "invalid",
    },
    () => steps.pageSkyCubeReadFaces(READ_ARGS),
  );
  const verdicts = landingVerdicts(
    [
      {
        run: 0,
        cell: "E-SKY-cube",
        renderer: "webgpu",
        page: "scene",
        kind: "sky-cube",
        notRun: null,
        gate: { deviceLost: false },
        skyCube: raw,
      },
    ],
    null,
  ).filter((v) => v.id.endsWith(":sky-cube-read"));
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].pass, false);
  assert.equal(verdicts[0].notRun, true);
  assert.match(verdicts[0].reason, /GPU validation error/);
});

// ---------------------------------------------------------------------------
// Inertness: each rule made unreachable; the SAME behaviour, which passes on
// the real module, must then fail with an AssertionError.
// ---------------------------------------------------------------------------

async function assertRed(behaviour, replacements, why) {
  await behaviour(steps);
  const mutated = await importMutated(MODULE, replacements);
  await assert.rejects(
    async () => behaviour(mutated),
    assert.AssertionError,
    why,
  );
}

test("inertness: the settled gate made unreachable reads a cache that never settled", async () => {
  await assertRed(
    behaviourSettled,
    [["cache.needsUpdate === false", "true"]],
    "the settled gate",
  );
});

test("inertness: the missing-cube guard made unreachable loses the seam the reason names", async () => {
  await assertRed(
    behaviourMissingCube,
    [["if (!cache || !cache.cubemapTexture) {", "if (false) {"]],
    "the missing-cube guard",
  );
});

test("inertness: the identity rule made unreachable turns equal faces into DIFFERS", async () => {
  await assertRed(
    behaviourIdentity,
    [
      [
        "const identical =\n      faceBefore.sha256",
        "const identical = false &&\n      faceBefore.sha256",
      ],
    ],
    "the identity rule",
  );
});

test("inertness: the per-face rule made unreachable passes a cube with empty faces", async () => {
  await assertRed(
    behaviourPerFace,
    [["if (empty.length > 0) {", "if (false && empty.length > 0) {"]],
    "the per-face rule",
  );
});

test("inertness: the validation-error check made unreachable maps a buffer the invalid pass never wrote", async () => {
  await assertRed(
    behaviourScope,
    [["if (validationError) {", "if (false && validationError) {"]],
    "the scope check",
  );
});

test("inertness: a readback shader writing x and y swapped reads other bytes", async () => {
  await assertRed(
    behaviourLayout,
    [
      [
        "let i = (id.z * n + id.y) * n + id.x;",
        "let i = (id.z * n + id.x) * n + id.y;",
      ],
    ],
    "the write layout",
  );
});
