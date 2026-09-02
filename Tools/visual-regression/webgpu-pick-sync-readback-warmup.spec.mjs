// webgpu-pick-sync-readback-warmup.spec.mjs — behaviour coverage of the
// SYNCHRONOUS WebGPU pick warm-up path, driven against the real
// `WebGPUPickFramebuffer` over a fake device. Pure Node: no browser, no GPU.
//
// @purpose Behaviour spec for synchronous WebGPU pick warm-up: a pick at a new position must arm its own readback even while an earlier one is still mapping, and the cached-region gate's pixel tolerance is pinned.
// @status ACTIVE
//
// THE BEHAVIOUR UNDER TEST, STATED WITHOUT REFERENCE TO THE IMPLEMENTATION.
// WebGPU cannot read a render target back synchronously, so `scene.pick()` is
// documented as one pick-pass stale: the caller picks once to warm the
// position, lets a frame go by, and picks again to get the answer. Every probe
// in this repository and every hover demo relies on that contract.
//
// The contract silently failed for any caller that picks at MORE THAN ONE
// position, because the warm-up pick for a new position and the previous
// position's answering pick happen in the same task. Only one readback could be
// in flight at a time, so the warm-up pick for the new position was dropped,
// and the answering pick one frame later decoded the PREVIOUS position's
// pixels — a guaranteed miss no matter what is on screen.
//
// THE EXACT SCOPE OF THAT FAILURE, because an overstated one would let a future
// reader close the row on this fix. A search that starts cold has nothing in
// flight, so its FIRST position is warmed cleanly and is found. Every position
// AFTER the first was the guaranteed miss. The mutant test at the bottom of
// this file pins both halves. The 2026-09-01 AEC measurement recorded a miss on
// WebGPU at its first candidate (384,252) where WebGL hit — that miss is NOT
// explained by this defect and this fix does not address it.
//
// The assertions below are written as caller-visible outcomes — "a pick at this
// position, one frame after its own warm-up pick, returns the object painted
// there" — not as counter shapes, so they stay meaningful if the internals are
// rewritten. Counters are read only to say WHY a miss happened when one is
// expected.
//
// WHAT THIS SPEC DELIBERATELY DOES NOT CLAIM. It does not attribute the
// residual AEC pick misses: the first-candidate miss described above, and the
// 4-17 of 40 at one position under a starved frame loop. Those need the decline
// counters read in a browser against a live scene; that is
// `probe-q141-pick-readback.mjs`, and the row stays open until it reports.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle } from "./lib/engine-stub-bundler.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const FRAMEBUFFER_PATH = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts",
);
const CORE_DIR = path.join(ROOT, "packages/engine/Source/Core");

globalThis.GPUTextureUsage ??= {
  RENDER_ATTACHMENT: 1,
  COPY_SRC: 2,
  TEXTURE_BINDING: 4,
  COPY_DST: 8,
};
globalThis.GPUBufferUsage ??= { COPY_DST: 1, MAP_READ: 2 };
globalThis.GPUMapMode ??= { READ: 1 };

const VIEWPORT_SIZE = 64;
const PICK_RECTANGLE_SIZE = 3;

/**
 * A pick attachment the spec can paint. Coordinates are absolute and top-down,
 * matching what `copyTextureToBuffer` receives as its origin.
 */
class FakeAttachment {
  constructor(size) {
    this.size = size;
    this.bytes = new Uint8Array(size * size * 4);
  }

  paint(x, y, rgba) {
    this.bytes.set(rgba, (y * this.size + x) * 4);
  }

  copyInto(target, origin, copyWidth, copyHeight, bytesPerRow) {
    for (let row = 0; row < copyHeight; row++) {
      const srcOffset = ((origin[1] + row) * this.size + origin[0]) * 4;
      target.set(
        this.bytes.subarray(srcOffset, srcOffset + copyWidth * 4),
        row * bytesPerRow,
      );
    }
  }
}

function createResolvers() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeBuffer {
  constructor(size, device) {
    this.size = size;
    this.device = device;
    this.bytes = new Uint8Array(size);
    this.destroyed = false;
    this.mapped = false;
    this.pending = null;
  }

  mapAsync() {
    this.pending = createResolvers();
    this.device.outstandingMaps.push(this);
    return this.pending.promise;
  }

  settle() {
    if (!this.pending) {
      return;
    }
    const pending = this.pending;
    this.pending = null;
    this.mapped = true;
    pending.resolve();
  }

  getMappedRange() {
    return this.bytes.buffer;
  }

  unmap() {
    this.mapped = false;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeDevice {
  constructor(attachment) {
    this.attachment = attachment;
    this.buffers = [];
    this.outstandingMaps = [];
    this.submits = 0;
    this.queue = {
      submit: () => {
        this.submits++;
      },
      writeTexture: () => {},
    };
  }

  createTexture(descriptor) {
    const texture = {
      descriptor,
      destroyed: false,
      createView: () => ({ texture }),
      destroy: () => {
        texture.destroyed = true;
      },
    };
    return texture;
  }

  createBuffer(descriptor) {
    const buffer = new FakeBuffer(descriptor.size, this);
    this.buffers.push(buffer);
    return buffer;
  }

  createCommandEncoder(descriptor = {}) {
    return {
      // The copy is filled from the attachment as it is encoded. Nothing in
      // these tests repaints the attachment between encode and submit, so this
      // is byte-equivalent to filling at submit time while removing a layer of
      // ordering bookkeeping from the fake.
      copyTextureToBuffer: (source, destination, copySize) => {
        this.attachment.copyInto(
          destination.buffer.bytes,
          source.origin,
          copySize[0],
          copySize[1],
          destination.bytesPerRow,
        );
      },
      beginRenderPass: () => ({
        setViewport() {},
        setScissorRect() {},
        end() {},
      }),
      finish: () => ({ label: descriptor.label ?? "unlabelled" }),
    };
  }
}

/**
 * A context carrying only the surface `WebGPUPickFramebuffer` reads, plus the
 * frame-encoder lifecycle `Picking.pick` drives: the framebuffer's `begin()`
 * opens the mini frame, `end()` encodes into it, and `completePickFrame` (here
 * `endFrame`) submits it and runs the after-submit callbacks that start maps.
 */
function createHarness() {
  const attachment = new FakeAttachment(VIEWPORT_SIZE);
  const device = new FakeDevice(attachment);
  const pickables = new Map();
  let currentCommandEncoder = null;
  let afterFrameSubmit = [];

  const context = {
    _device: device,
    resourceGeneration: 1,
    pickPipelineFormat: "rgba8unorm",
    scenePipelineFormat: "rgba8unorm",
    uniformState: {},
    _currentRenderPassEncoder: null,
    _pickClassificationDepthView: null,
    getObjectByPickColor: (key) => pickables.get(key),
    beginPickFrame() {
      currentCommandEncoder ??= device.createCommandEncoder({
        label: "pick-frame",
      });
    },
    get currentCommandEncoder() {
      return currentCommandEncoder;
    },
    enqueueAfterFrameSubmit(callback) {
      if (!currentCommandEncoder) {
        return false;
      }
      afterFrameSubmit.push(callback);
      return true;
    },
    endFrame() {
      const encoder = currentCommandEncoder;
      if (!encoder) {
        return;
      }
      currentCommandEncoder = null;
      device.queue.submit([encoder.finish()]);
      const callbacks = afterFrameSubmit;
      afterFrameSubmit = [];
      for (const callback of callbacks) {
        callback(true);
      }
    },
  };

  return { attachment, context, device, pickables };
}

const viewport = {
  x: 0,
  y: 0,
  width: VIEWPORT_SIZE,
  height: VIEWPORT_SIZE,
};

/**
 * The drawing-buffer rectangle `Picking.pick` builds for a window position:
 * bottom-origin y, 3x3 around the cursor.
 */
function pickRectangle(windowX, windowY) {
  const half = (PICK_RECTANGLE_SIZE - 1) * 0.5;
  return {
    x: windowX - half,
    y: VIEWPORT_SIZE - windowY - half,
    width: PICK_RECTANGLE_SIZE,
    height: PICK_RECTANGLE_SIZE,
  };
}

/**
 * The absolute top-down attachment pixel the 3x3 decode treats as the cursor:
 * top-down origin `height - glOriginY - pickHeight` plus the spiral's
 * `floor(size / 2)` center.
 */
function centerPixelOf(windowX, windowY) {
  const rectangle = pickRectangle(windowX, windowY);
  const originTopY =
    VIEWPORT_SIZE - Math.floor(rectangle.y) - PICK_RECTANGLE_SIZE;
  return {
    x: Math.floor(rectangle.x) + Math.floor(PICK_RECTANGLE_SIZE / 2),
    y: originTopY + Math.floor(PICK_RECTANGLE_SIZE / 2),
  };
}

/** Pick-id colors pack the key low byte first, as `Color.fromRgba` does. */
function pickIdBytes(key) {
  return [
    key & 0xff,
    (key >> 8) & 0xff,
    (key >> 16) & 0xff,
    (key >> 24) & 0xff,
  ];
}

function paintFeature(harness, windowX, windowY, key, object) {
  const center = centerPixelOf(windowX, windowY);
  harness.attachment.paint(center.x, center.y, pickIdBytes(key));
  harness.pickables.set(key, object);
}

/** One synchronous `scene.pick()`: begin, end, submit the mini frame. */
function syncPick(framebuffer, harness, windowX, windowY) {
  const rectangle = pickRectangle(windowX, windowY);
  framebuffer.begin(rectangle, viewport, undefined, "static-view");
  const picked = framebuffer.end(rectangle, 1);
  harness.context.endFrame();
  return picked;
}

/** Let every outstanding map resolve, as a real frame boundary would. */
async function settleReadbacks(device) {
  const outstanding = device.outstandingMaps;
  device.outstandingMaps = [];
  for (const buffer of outstanding) {
    buffer.settle();
  }
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

const sourcePromise = readFile(FRAMEBUFFER_PATH, "utf8").then((text) =>
  text.split("\r\n").join("\n"),
);

/**
 * Builds the real framebuffer module with `Core/` kept real (the pick-id
 * decode is `Color.bytesToRgba`, so stubbing it would replace the behaviour
 * under test with a Proxy) and everything else stubbed.
 *
 * @param {{mutate?: Function, label?: string}} [options] Optional source
 *   rewrite, used by the inertness mutant.
 * @returns {Promise<object>} The module namespace.
 */
async function loadModule(options = {}) {
  return bundle({
    path: FRAMEBUFFER_PATH,
    source: await sourcePromise,
    real: [
      "BoundingRectangle",
      "Color",
      "defined",
      "WebGPUPickTransientReadback",
    ],
    realDir: CORE_DIR,
    mutate: options.mutate,
    label: options.label,
  });
}

const modulePromise = loadModule();

async function createFramebuffer(module) {
  const { WebGPUPickFramebuffer } = module ?? (await modulePromise);
  const harness = createHarness();
  return { framebuffer: new WebGPUPickFramebuffer(harness.context), harness };
}

// ---------------------------------------------------------------------------
// A. The warm-up contract must hold for a caller that moves between positions.
// ---------------------------------------------------------------------------

test("a pick warms its own position even when an earlier readback is still mapping", async () => {
  const { framebuffer, harness } = await createFramebuffer();
  const featureA = { name: "A" };
  const featureB = { name: "B" };
  paintFeature(harness, 20, 20, 7, featureA);
  paintFeature(harness, 40, 40, 9, featureB);

  // Candidate A's answering pick arms a readback and leaves it in flight —
  // exactly the state a hit search is in when it moves to the next candidate.
  assert.deepEqual(syncPick(framebuffer, harness, 20, 20), []);
  assert.equal(
    harness.device.outstandingMaps.length,
    1,
    "the first pick must arm a readback",
  );

  // Candidate B's WARM-UP pick, issued in the same task. This is the pick whose
  // readback the next frame's answer depends on.
  assert.deepEqual(
    syncPick(framebuffer, harness, 40, 40),
    [],
    "a warm-up pick at a cold position returns nothing, as documented",
  );

  await settleReadbacks(harness.device);

  // One frame later, candidate B's ANSWERING pick. The feature is painted at
  // that exact pixel, so the documented one-frame-stale contract says it comes
  // back here.
  const answered = syncPick(framebuffer, harness, 40, 40);
  const statistics = framebuffer.getStatistics();
  assert.deepEqual(
    answered,
    [featureB],
    `the answering pick must return the object painted under the cursor; serveDeclines ${JSON.stringify(
      statistics.serveDeclines,
    )} armDeclines ${JSON.stringify(statistics.armDeclines)}`,
  );
});

test("a hit search that alternates positions finds the painted feature", async () => {
  const { framebuffer, harness } = await createFramebuffer();
  const target = { name: "target" };
  // Only the fifth candidate carries a feature; the first four are empty sky.
  const candidates = [
    [10, 12],
    [18, 12],
    [26, 12],
    [34, 12],
    [42, 12],
  ];
  paintFeature(harness, 42, 12, 11, target);

  let found = null;
  for (const [x, y] of candidates) {
    syncPick(framebuffer, harness, x, y); // warm-up pick
    await settleReadbacks(harness.device); // a frame goes by
    const picked = syncPick(framebuffer, harness, x, y); // answering pick
    if (picked.length > 0) {
      found = { x, y, picked };
      break;
    }
  }

  assert.notEqual(
    found,
    null,
    `the search must reach the painted candidate; serveDeclines ${JSON.stringify(
      framebuffer.getStatistics().serveDeclines,
    )}`,
  );
  assert.deepEqual(found.picked, [target]);
  assert.deepEqual([found.x, found.y], [42, 12]);
});

// ---------------------------------------------------------------------------
// B. The cached-region gate's pixel tolerance, quantified.
// ---------------------------------------------------------------------------

test("a warmed 3x3 readback answers a cursor that moved one pixel and declines past it", async () => {
  const { framebuffer, harness } = await createFramebuffer();
  const feature = { name: "wall" };
  // A 3-pixel horizontal run, so a one-pixel cursor move still lands on the
  // feature; the question under test is the GATE, not the geometry.
  const center = centerPixelOf(30, 30);
  for (let offset = -1; offset <= 1; offset++) {
    harness.attachment.paint(center.x + offset, center.y, pickIdBytes(5));
  }
  harness.pickables.set(5, feature);

  syncPick(framebuffer, harness, 30, 30);
  await settleReadbacks(harness.device);

  const beforeOnePixel = framebuffer.getStatistics().servedCached;
  const onePixel = syncPick(framebuffer, harness, 31, 30);
  const afterOnePixel = framebuffer.getStatistics();
  assert.deepEqual(
    onePixel,
    [feature],
    "one pixel of cursor motion must still decode from the warmed region",
  );
  assert.equal(
    afterOnePixel.servedCached - beforeOnePixel,
    1,
    "the one-pixel case is the reprojected-cache serve, not an exact-match one",
  );

  // Four pixels puts the cursor outside the warmed 3x3 entirely. Nothing about
  // this is a defect — it is the documented fail-closed gate — but the exact
  // tolerance is what a probe's jitter has to stay inside, so it is pinned.
  await settleReadbacks(harness.device);
  const beforeFarPixel = framebuffer.getStatistics();
  const farPixel = syncPick(framebuffer, harness, 34, 30);
  const afterFarPixel = framebuffer.getStatistics();
  assert.deepEqual(
    farPixel,
    [],
    "a cursor four pixels away cannot be answered from the warmed region",
  );
  assert.equal(
    afterFarPixel.serveDeclines["center-outside-cached-region"] -
      beforeFarPixel.serveDeclines["center-outside-cached-region"],
    1,
  );
});

// ---------------------------------------------------------------------------
// C. Staleness is counted in pick passes, and it is observable.
// ---------------------------------------------------------------------------

test("the age of a served result counts pick passes since the readback that produced it", async () => {
  const { framebuffer, harness } = await createFramebuffer();
  const feature = { name: "slab" };
  paintFeature(harness, 24, 24, 3, feature);

  syncPick(framebuffer, harness, 24, 24);
  await settleReadbacks(harness.device);

  // Re-pick the same position four times WITHOUT letting any new readback
  // resolve. Every answer is served from the one warmed readback, and its age
  // grows by exactly one pick pass each time.
  const ages = [];
  for (let i = 0; i < 4; i++) {
    const picked = syncPick(framebuffer, harness, 24, 24);
    assert.deepEqual(picked, [feature]);
    ages.push(framebuffer.getStatistics().age.max);
  }

  assert.deepEqual(
    ages,
    [1, 2, 3, 4],
    "a starved frame loop makes the served answer older by one pick pass per pick",
  );
});

// ---------------------------------------------------------------------------
// D. Inertness mutant. The two behaviour tests above must depend on the
//    overflow path being LIVE, not merely present in the source.
// ---------------------------------------------------------------------------

test("with the overflow readback made unreachable, the warm-up contract breaks again", async () => {
  const inert = await loadModule({
    label: "overflow-readback-inert",
    mutate: (source) =>
      source.replace(
        "const transientBuffer = this._readbackInFlight\n      ? this._transientReadbacks.acquire(device, bufferSize)\n      : null;",
        "const transientBuffer =\n      false && this._readbackInFlight\n        ? this._transientReadbacks.acquire(device, bufferSize)\n        : null;",
      ),
  });

  const { framebuffer, harness } = await createFramebuffer(inert);
  const featureB = { name: "B" };
  paintFeature(harness, 20, 20, 7, { name: "A" });
  paintFeature(harness, 40, 40, 9, featureB);

  syncPick(framebuffer, harness, 20, 20);
  syncPick(framebuffer, harness, 40, 40);
  await settleReadbacks(harness.device);
  const answered = syncPick(framebuffer, harness, 40, 40);

  const statistics = framebuffer.getStatistics();
  assert.deepEqual(
    answered,
    [],
    "the mutant must reproduce the original miss, otherwise the tests above " +
      "would pass without the fix and prove nothing",
  );
  assert.ok(
    statistics.armDeclines["readback-in-flight"] > 0,
    "the mutant must decline the warm-up pick's readback, which is the " +
      "mechanism the fix removes",
  );
  assert.ok(
    statistics.serveDeclines["center-outside-cached-region"] > 0,
    "and the answering pick must fall back to the previous position's region",
  );
});

test("the mutant still finds a feature under the FIRST search position", async () => {
  // The scope claim in this file's header is a fact about the pre-fix engine,
  // so it is pinned here rather than asserted in prose. A search that starts
  // cold has no readback in flight, so its first warm-up pick is served by the
  // persistent buffer and succeeds even with the overflow path unreachable.
  // Keeping this green is what stops the header's claim from drifting into
  // "the search could never find anything", which would wrongly attribute the
  // measured first-candidate miss to the defect this file covers.
  const inert = await loadModule({
    label: "overflow-readback-inert-first-position",
    mutate: (source) =>
      source.replace(
        "const transientBuffer = this._readbackInFlight\n      ? this._transientReadbacks.acquire(device, bufferSize)\n      : null;",
        "const transientBuffer =\n      false && this._readbackInFlight\n        ? this._transientReadbacks.acquire(device, bufferSize)\n        : null;",
      ),
  });

  const { framebuffer, harness } = await createFramebuffer(inert);
  const target = { name: "first" };
  paintFeature(harness, 10, 12, 11, target);

  syncPick(framebuffer, harness, 10, 12); // warm-up pick, nothing in flight
  await settleReadbacks(harness.device);
  const answered = syncPick(framebuffer, harness, 10, 12);

  assert.deepEqual(
    answered,
    [target],
    "the pre-fix engine answers the first position of a cold search, so a " +
      "miss there is a different defect and this fix must not claim it",
  );
});
