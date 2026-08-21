/**
 * Pure-Node spec for the WebGPU pick-framebuffer instrumentation.
 *
 * Runs the REAL `WebGPUPickFramebuffer` against a fake GPU device rather than a
 * re-implementation of its counter logic, so the spec cannot pass while the
 * shipped class drifts. It asserts two things the counters exist to answer:
 * that each outcome moves its own counter in the right direction, and that a
 * decline is attributed to a distinguishable reason rather than to an
 * undifferentiated "declined" tally.
 *
 * Run: node --test packages/engine/Specs/Renderer/WebGPU/WebGPUPickFramebufferStatsSpec.mjs
 */
import assert from "node:assert/strict";
// Imported rather than taken from the global scope so the file lints under the
// engine Specs config, which targets the browser globals the Jasmine suite has.
import console from "node:console";
import { dirname, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { setImmediate } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "../../../../../Tools/visual-regression/lib/engine-ts-resolver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(HERE, "../../../Source");

// The engine's WebGPU modules reference these WebGPU enums at call time. Node
// has no WebGPU implementation, and the values are never interpreted by the
// fake device — only passed through — so any distinct bits will do.
globalThis.GPUTextureUsage = globalThis.GPUTextureUsage ?? {
  RENDER_ATTACHMENT: 0x10,
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
};
globalThis.GPUBufferUsage = globalThis.GPUBufferUsage ?? {
  COPY_DST: 0x08,
  MAP_READ: 0x01,
};
globalThis.GPUMapMode = globalThis.GPUMapMode ?? { READ: 0x01 };

enableEngineTsResolution();

// Defaults to the shipped module. The override exists so a mutation run can
// point the same assertions at a deliberately broken copy and confirm they go
// red — a spec that has never been seen to fail has not been shown to measure
// anything.
const MODULE_URL =
  process.env.CESIUM_PICK_FRAMEBUFFER_MODULE ??
  pathToFileURL(
    resolve(ENGINE_SOURCE, "Renderer/WebGPU/WebGPUPickFramebuffer.ts"),
  ).href;

const { WebGPUPickFramebuffer, WebGPUPickFramebufferStats } = await import(
  MODULE_URL
);
const { default: BoundingRectangle } = await import(
  pathToFileURL(resolve(ENGINE_SOURCE, "Core/BoundingRectangle.js")).href
);

// The first cold synchronous pick emits a permanent one-shot guidance warning.
// It is expected behaviour, not spec output, so keep it out of the report.
const realWarn = console.warn;
console.warn = () => {};
process.on("exit", () => {
  console.warn = realWarn;
});

class FakeBuffer {
  constructor(size, label) {
    this.size = size;
    this.label = label;
    this.destroyed = false;
    this.bytes = new Uint8Array(size);
    this._resolvers = [];
  }

  mapAsync() {
    return new Promise((resolveMap) => {
      this._resolvers.push(resolveMap);
    });
  }

  settleMap() {
    const resolvers = this._resolvers.splice(0);
    for (const resolveMap of resolvers) {
      resolveMap();
    }
    return resolvers.length;
  }

  getMappedRange(offset = 0, size = this.size - offset) {
    return this.bytes.buffer.slice(offset, offset + size);
  }

  unmap() {}

  destroy() {
    this.destroyed = true;
  }
}

class FakeEncoder {
  constructor() {
    this.copies = [];
  }

  copyTextureToBuffer(source, destination, extent) {
    this.copies.push({ source, destination, extent });
  }

  finish() {
    return { commands: this.copies.length };
  }
}

class FakeDevice {
  constructor() {
    this.buffers = [];
    this.submits = 0;
    this.queue = {
      submit: () => {
        this.submits++;
      },
      writeTexture: () => {},
    };
  }

  createTexture(descriptor) {
    return {
      label: descriptor.label,
      createView: () => ({ label: `${descriptor.label} view` }),
      destroy: () => {},
    };
  }

  createBuffer(descriptor) {
    const buffer = new FakeBuffer(descriptor.size, descriptor.label);
    this.buffers.push(buffer);
    return buffer;
  }

  createCommandEncoder() {
    return new FakeEncoder();
  }
}

function makeContext(device) {
  const context = {
    _device: device,
    resourceGeneration: 0,
    pickPipelineFormat: "rgba8unorm",
    currentCommandEncoder: new FakeEncoder(),
    pendingSubmitCallbacks: [],
    acceptSubmit: true,
    beginPickFrame() {},
    getObjectByPickColor() {
      return undefined;
    },
    enqueueAfterFrameSubmit(callback) {
      if (!context.acceptSubmit) {
        return false;
      }
      context.pendingSubmitCallbacks.push(callback);
      return true;
    },
  };
  return context;
}

function makeHarness() {
  const device = new FakeDevice();
  const context = makeContext(device);
  const framebuffer = new WebGPUPickFramebuffer(context);
  return { device, context, framebuffer };
}

const VIEWPORT = { width: 64, height: 48 };

function rect(x, y, width, height) {
  return new BoundingRectangle(x, y, width, height);
}

/**
 * Drive the frame submit + buffer map that the readback awaits, then let the
 * `.then` chain run. Without this the publish never happens, which is exactly
 * the "armed but unresolved" state the counters distinguish.
 */
async function settleReadbacks(context, device, submitted = true) {
  const callbacks = context.pendingSubmitCallbacks.splice(0);
  for (const callback of callbacks) {
    callback(submitted);
  }
  for (const buffer of device.buffers) {
    buffer.settleMap();
  }
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
}

async function pickOnce(harness, pickRect, provenance) {
  harness.framebuffer.begin(pickRect, VIEWPORT, undefined, provenance);
  return harness.framebuffer.end(pickRect);
}

function sumCounts(counts) {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

test("a cold sync pick counts as cold and names its reason", async () => {
  const harness = makeHarness();
  const query = rect(10, 10, 3, 3);

  await pickOnce(harness, query, "view-a");
  const stats = harness.framebuffer.getStatistics();

  assert.equal(stats.endCalls, 1);
  assert.equal(stats.cold, 1);
  assert.equal(stats.servedFresh, 0);
  assert.equal(stats.servedCached, 0);
  assert.equal(stats.serveDeclines["no-cached-readback"], 1);
  assert.equal(stats.age.samples, 0, "a cold pick contributes no age sample");
  assert.equal(stats.readbacksArmed, 1, "the cold pick still arms a readback");
  assert.equal(stats.readbacksPublished, 0);
});

test("an exact repeat after the readback resolves serves fresh at age 1", async () => {
  const harness = makeHarness();
  const query = rect(10, 10, 3, 3);

  await pickOnce(harness, query, "view-a");
  await settleReadbacks(harness.context, harness.device);
  assert.equal(harness.framebuffer.getStatistics().readbacksPublished, 1);

  await pickOnce(harness, query, "view-a");
  const stats = harness.framebuffer.getStatistics();

  assert.equal(stats.servedFresh, 1);
  assert.equal(stats.servedCached, 0);
  assert.equal(stats.cold, 1, "only the first pick was cold");
  assert.equal(stats.age.last, 1, "age is measured in pick passes");
  assert.equal(stats.age.max, 1);
  assert.equal(stats.age.samples, 1);
});

test("a shifted cursor under the same view serves from the widened gate", async () => {
  const harness = makeHarness();

  await pickOnce(harness, rect(10, 10, 9, 9), "view-a");
  await settleReadbacks(harness.context, harness.device);

  // Center moves from 14 to 15 — a different logical region, still inside the
  // cached one, so the exact-match path misses and the reprojection serves.
  await pickOnce(harness, rect(11, 10, 9, 9), "view-a");
  const stats = harness.framebuffer.getStatistics();

  assert.equal(stats.servedCached, 1);
  assert.equal(stats.servedFresh, 0);
  assert.equal(stats.age.last, 1);
});

test("decline reasons are distinguishable, not one undifferentiated tally", async () => {
  // Camera motion: the provenance gate declines, and says so.
  const moved = makeHarness();
  await pickOnce(moved, rect(10, 10, 3, 3), "view-a");
  await settleReadbacks(moved.context, moved.device);
  await pickOnce(moved, rect(10, 10, 3, 3), "view-b");
  const movedStats = moved.framebuffer.getStatistics();
  assert.equal(movedStats.serveDeclines["view-provenance-changed"], 1);
  assert.equal(
    movedStats.serveDeclines["no-cached-readback"],
    1,
    "the cold one",
  );
  assert.equal(movedStats.serveDeclines["center-outside-cached-region"], 0);

  // Cursor jump under a static view: a different gate, a different reason.
  const jumped = makeHarness();
  await pickOnce(jumped, rect(10, 10, 1, 1), "view-a");
  await settleReadbacks(jumped.context, jumped.device);
  await pickOnce(jumped, rect(40, 30, 1, 1), "view-a");
  const jumpedStats = jumped.framebuffer.getStatistics();
  assert.equal(jumpedStats.serveDeclines["center-outside-cached-region"], 1);
  assert.equal(jumpedStats.serveDeclines["view-provenance-changed"], 0);

  // No device at all is its own reason, not "no cached readback".
  const deviceless = new WebGPUPickFramebuffer(makeContext(null));
  deviceless.end(rect(0, 0, 1, 1));
  const devicelessStats = deviceless.getStatistics();
  assert.equal(devicelessStats.serveDeclines["no-device"], 1);
  assert.equal(devicelessStats.cold, 1);

  // A device with no pick attachment yet is a third, separate reason.
  const unbegun = makeHarness();
  unbegun.framebuffer.end(rect(0, 0, 1, 1));
  const unbegunStats = unbegun.framebuffer.getStatistics();
  assert.equal(unbegunStats.serveDeclines["no-attachment"], 1);
  assert.equal(unbegunStats.serveDeclines["no-device"], 0);
});

test("a second pick before the map resolves is an in-flight suppression", async () => {
  const harness = makeHarness();
  const query = rect(10, 10, 3, 3);

  await pickOnce(harness, query, "view-a");
  assert.equal(harness.framebuffer.getStatistics().readbacksArmed, 1);

  // Deliberately do NOT settle: the previous staging buffer is still
  // mapping-pending, so the next pick must not encode another copy into it.
  await pickOnce(harness, query, "view-a");
  const stats = harness.framebuffer.getStatistics();

  assert.equal(stats.armDeclines["readback-in-flight"], 1);
  assert.equal(stats.readbackInFlightSuppressions, 1);
  assert.equal(stats.readbacksArmed, 1, "the suppressed pick armed nothing");
  assert.equal(stats.readbacksUnresolved, 1, "the first readback never landed");
});

test("a rejected frame submit is an arm decline, never an arm", async () => {
  const harness = makeHarness();
  harness.context.acceptSubmit = false;

  await pickOnce(harness, rect(10, 10, 3, 3), "view-a");
  const stats = harness.framebuffer.getStatistics();

  assert.equal(stats.armDeclines["frame-submit-rejected"], 1);
  assert.equal(stats.readbacksArmed, 0);
  assert.equal(stats.readbacksPublished, 0);
});

test("bytes that outlive their view are a publish decline, not a publish", async () => {
  const harness = makeHarness();
  const query = rect(10, 10, 3, 3);

  await pickOnce(harness, query, "view-a");
  // The camera moves between arming and the map resolving. The bytes describe
  // a view nobody is asking about any more.
  harness.framebuffer.begin(query, VIEWPORT, undefined, "view-b");
  await settleReadbacks(harness.context, harness.device);

  const stats = harness.framebuffer.getStatistics();
  assert.equal(stats.publishDeclines["view-provenance-changed"], 1);
  assert.equal(stats.readbacksPublished, 0);
  assert.equal(stats.readbacksArmed, 1);
  assert.equal(stats.readbacksUnresolved, 0, "declined is accounted, not lost");
});

test("a frame that never submits declines the arm rather than hanging it", async () => {
  const harness = makeHarness();

  await pickOnce(harness, rect(10, 10, 3, 3), "view-a");
  await settleReadbacks(harness.context, harness.device, false);

  const stats = harness.framebuffer.getStatistics();
  assert.equal(stats.armDeclines["frame-not-submitted"], 1);
  assert.equal(stats.readbacksPublished, 0);
});

test("center-pixel reads separate a cold query from a stale one", async () => {
  const harness = makeHarness();
  const query = rect(10, 10, 1, 1);
  const owner = { id: "table" };
  const lifecycle = { device: harness.device };

  harness.framebuffer.begin(query, VIEWPORT, "metadata", "view-a");
  const cold = harness.framebuffer.readCenterPixel(
    query,
    "metadata",
    owner,
    lifecycle,
    1,
    undefined,
    "view-a",
  );
  assert.equal(cold, undefined);
  let stats = harness.framebuffer.getStatistics();
  assert.equal(stats.centerPixel.reads, 1);
  assert.equal(stats.centerPixel.declines["no-cache-entry"], 1);
  assert.equal(stats.centerPixel.armed, 1);
  assert.equal(stats.centerPixel.published, 0);

  await settleReadbacks(harness.context, harness.device);
  stats = harness.framebuffer.getStatistics();
  assert.equal(stats.centerPixel.published, 1);

  harness.framebuffer.begin(query, VIEWPORT, "metadata", "view-a");
  const warm = harness.framebuffer.readCenterPixel(
    query,
    "metadata",
    owner,
    lifecycle,
    1,
    undefined,
    "view-a",
  );
  assert.ok(warm instanceof Uint8Array);
  stats = harness.framebuffer.getStatistics();
  assert.equal(stats.centerPixel.served, 1);
  assert.equal(stats.centerPixel.age.last, 1);
  assert.equal(
    stats.centerPixel.declines["no-cache-entry"],
    1,
    "the warm read is not counted as cold",
  );
});

test("the recorded totals cannot drift from their reasons", async () => {
  const harness = makeHarness();

  await pickOnce(harness, rect(10, 10, 5, 5), "view-a");
  await settleReadbacks(harness.context, harness.device);
  await pickOnce(harness, rect(10, 10, 5, 5), "view-a");
  await settleReadbacks(harness.context, harness.device);
  await pickOnce(harness, rect(11, 10, 5, 5), "view-a");
  await settleReadbacks(harness.context, harness.device);
  await pickOnce(harness, rect(11, 10, 5, 5), "view-b");
  await settleReadbacks(harness.context, harness.device);
  await pickOnce(harness, rect(40, 30, 5, 5), "view-b");
  await settleReadbacks(harness.context, harness.device);

  const stats = harness.framebuffer.getStatistics();
  assert.equal(
    stats.endCalls,
    stats.servedFresh + stats.servedCached + stats.cold,
    "every end() lands on exactly one outcome",
  );
  assert.equal(
    stats.cold,
    sumCounts(stats.serveDeclines),
    "every cold pick carries exactly one reason",
  );
  assert.ok(
    stats.readbacksArmed >=
      stats.readbacksPublished + sumCounts(stats.publishDeclines),
    "a publish or a publish decline requires a prior arm",
  );
  assert.equal(
    stats.readbacksUnresolved,
    stats.readbacksArmed -
      stats.readbacksPublished -
      sumCounts(stats.publishDeclines),
  );
  assert.ok(stats.servedFresh > 0 && stats.servedCached > 0 && stats.cold > 0);
});

test("a snapshot is a copy and reset zeroes the counters", async () => {
  const harness = makeHarness();
  await pickOnce(harness, rect(10, 10, 3, 3), "view-a");

  const snapshot = harness.framebuffer.getStatistics();
  snapshot.serveDeclines["no-cached-readback"] = 999;
  snapshot.cold = 999;
  assert.equal(
    harness.framebuffer.getStatistics().serveDeclines["no-cached-readback"],
    1,
    "mutating a snapshot must not touch the live counters",
  );

  harness.framebuffer.resetStatistics();
  const cleared = harness.framebuffer.getStatistics();
  assert.equal(cleared.endCalls, 0);
  assert.equal(cleared.cold, 0);
  assert.equal(sumCounts(cleared.serveDeclines), 0);
  assert.equal(cleared.age.samples, 0);
  assert.equal(cleared.age.last, null);
});

test("the decline history is well formed wherever it survives the pragma", async () => {
  const harness = makeHarness();
  await pickOnce(harness, rect(10, 10, 3, 3), "view-a");

  const { recentDeclines } = harness.framebuffer.getStatistics();
  assert.ok(Array.isArray(recentDeclines));
  // Empty in a pragma-stripped production build; populated when running the
  // source, as here. Either way the aggregates above already carried the count.
  for (const entry of recentDeclines) {
    assert.ok(
      ["serve", "arm", "publish", "centerPixel"].includes(entry.stage),
      `unexpected stage ${entry.stage}`,
    );
    assert.equal(typeof entry.reason, "string");
    assert.equal(typeof entry.updateCount, "number");
  }
});

test("the counter block's derived values sum the shapes they claim to", () => {
  const stats = new WebGPUPickFramebufferStats();

  stats.recordArmDecline("readback-in-flight", 1);
  stats.recordArmDecline("staging-buffer-in-flight", 2);
  stats.recordArmDecline("no-frame-encoder", 3);
  assert.equal(
    stats.readbackInFlightSuppressions,
    2,
    "only the two in-flight shapes count as suppressions",
  );

  stats.recordReadbackArmed();
  stats.recordReadbackArmed();
  stats.recordReadbackArmed();
  stats.recordReadbackPublished();
  stats.recordPublishDecline("destroyed", 4);
  assert.equal(stats.readbacksUnresolved, 1);

  stats.recordServedFresh(0);
  stats.recordServedFresh(4);
  stats.recordServedCached(2);
  const age = stats.getStatistics().age;
  assert.deepEqual(
    { min: age.min, max: age.max, mean: age.mean, samples: age.samples },
    { min: 0, max: 4, mean: 2, samples: 3 },
  );
});
