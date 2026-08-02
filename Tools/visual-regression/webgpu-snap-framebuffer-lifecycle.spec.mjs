// Browser-free behavioral lifecycle coverage for C11-212. This drives the
// real WebGPUSnapFramebuffer class with GPU-shaped mocks; it complements the
// source-contract assertions in webgpu-snap-payload.spec.mjs and remains useful
// when an unrelated barrel/export failure blocks Karma before browser launch.

import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

globalThis.GPUTextureUsage ??= {
  RENDER_ATTACHMENT: 0x10,
  COPY_SRC: 0x01,
};
globalThis.GPUBufferUsage ??= {
  COPY_DST: 0x08,
  MAP_READ: 0x01,
};
globalThis.GPUMapMode ??= { READ: 0x01 };

const directory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(directory, "../..");
const { WebGPUSnapFramebuffer } = await import(
  pathToFileURL(
    resolve(
      repoRoot,
      "packages/engine/Source/Renderer/WebGPU/WebGPUSnapFramebuffer.ts",
    ),
  ).href
);
const { packSnapDepthAndEdge } = await import(
  pathToFileURL(
    resolve(
      repoRoot,
      "packages/engine/Source/Renderer/WebGPU/WebGPUSnapPayload.ts",
    ),
  ).href
);

function makeView(windowX, overrides = {}) {
  return Object.freeze({
    sceneFrameNumber: overrides.sceneFrameNumber ?? 100,
    windowX,
    windowY: 50,
    canvasWidth: 100,
    canvasHeight: 100,
    drawingBufferWidth: 100,
    drawingBufferHeight: 100,
    viewportX: 0,
    viewportY: 0,
    viewportWidth: 100,
    viewportHeight: 100,
    positionX: overrides.positionX ?? 0,
    positionY: 0,
    positionZ: 0,
    directionX: 0,
    directionY: 0,
    directionZ: -1,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    upX: 0,
    upY: 1,
    upZ: 0,
    perspective: true,
    fovy: Math.PI * 0.5,
    aspectRatio: 1,
    near: 1,
    far: overrides.far ?? 500000000,
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    sceneMode: 3,
    mapMode2D: 1,
    wrapLongitude: false,
    maxCoordinateX: 0,
  });
}

function makeFramebuffer() {
  const buffers = [];
  const copies = [];
  const callbacks = [];
  const mapResolvers = [];
  const shaderModules = [];
  const renderPipelines = [];
  let privateSubmissions = 0;
  let privateEncoderCreations = 0;
  const encoder = {
    copyTextureToBuffer(source, destination, extent) {
      copies.push({ source, destination, extent });
    },
  };
  const device = {
    queue: {
      submit() {
        privateSubmissions++;
      },
    },
    createCommandEncoder() {
      privateEncoderCreations++;
      return encoder;
    },
    createTexture(descriptor) {
      const texture = {
        descriptor,
        destroyed: false,
        createView() {
          return { texture };
        },
        destroy() {
          this.destroyed = true;
        },
      };
      return texture;
    },
    createBuffer(descriptor) {
      const storage = new ArrayBuffer(descriptor.size);
      const buffer = {
        descriptor,
        storage,
        destroyed: false,
        mapped: false,
        mapAsync() {
          return new Promise((resolveMap) => {
            mapResolvers.push(() => {
              this.mapped = true;
              resolveMap();
            });
          });
        },
        getMappedRange() {
          return storage;
        },
        unmap() {
          this.mapped = false;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createShaderModule(descriptor) {
      const module = { descriptor };
      shaderModules.push(module);
      return module;
    },
    createRenderPipeline(descriptor) {
      const pipeline = { descriptor };
      renderPipelines.push(pipeline);
      return pipeline;
    },
  };
  const objects = new Map([
    [7, { id: "prior-near" }],
    [8, { id: "intersection" }],
  ]);
  const context = {
    _device: device,
    scenePipelineFormat: "rgba8unorm",
    currentCommandEncoder: encoder,
    beginPickFrame() {},
    enqueueAfterFrameSubmit(callback) {
      callbacks.push(callback);
      return true;
    },
    getObjectByPickColor(key) {
      return objects.get(key);
    },
  };
  const framebuffer = new WebGPUSnapFramebuffer(context);
  framebuffer._coldSnapWarned = true;
  framebuffer.begin(
    { x: 10, y: 10, width: 3, height: 3 },
    { x: 0, y: 0, width: 100, height: 100 },
  );
  return {
    framebuffer,
    context,
    device,
    buffers,
    callbacks,
    copies,
    mapResolvers,
    objects,
    shaderModules,
    renderPipelines,
    privateEncoderCreations: () => privateEncoderCreations,
    privateSubmissions: () => privateSubmissions,
  };
}

function writeHit(buffer, x, y, key, depth = 42, logicalSize = 3) {
  const words = new Uint32Array(buffer.storage);
  const wordsPerRow = 256 / 4;
  const half = Math.floor(logicalSize * 0.5);
  const index = (half + y) * wordsPerRow + (half + x) * 2;
  words[index] = key >>> 0;
  words[index + 1] = packSnapDepthAndEdge(depth, true);
}

async function completeSubmittedReadback(harness) {
  harness.callbacks.shift()(true);
  harness.mapResolvers.shift()();
  await Promise.resolve();
  await Promise.resolve();
}

test("coverage reset is lazy, query-pass local, and exact-device", () => {
  const harness = makeFramebuffer();
  const { framebuffer, context, shaderModules, renderPipelines } = harness;
  const state = framebuffer.begin(
    { x: 10, y: 10, width: 3, height: 3 },
    { x: 0, y: 0, width: 100, height: 100 },
  );
  const calls = [];
  const renderPass = {
    setPipeline(pipeline) {
      calls.push(["pipeline", pipeline]);
    },
    draw(vertexCount) {
      calls.push(["draw", vertexCount]);
    },
  };

  assert.equal(shaderModules.length, 0);
  assert.equal(renderPipelines.length, 0);
  state.framebuffer.resetSnapPayloadCoverage(renderPass);
  state.framebuffer.resetSnapPayloadCoverage(renderPass);
  assert.equal(shaderModules.length, 1);
  assert.equal(renderPipelines.length, 1);
  assert.deepEqual(calls, [
    ["pipeline", renderPipelines[0]],
    ["draw", 3],
    ["pipeline", renderPipelines[0]],
    ["draw", 3],
  ]);
  assert.deepEqual(renderPipelines[0].descriptor.fragment.targets, [
    { format: "rg32uint" },
  ]);
  assert.deepEqual(renderPipelines[0].descriptor.depthStencil, {
    format: "depth24plus-stencil8",
    depthWriteEnabled: false,
    depthCompare: "not-equal",
  });
  assert.match(
    shaderModules[0].descriptor.code,
    /vec4<f32>\(positions\[vertexIndex\], 1\.0, 1\.0\)/,
  );
  assert.match(shaderModules[0].descriptor.code, /return vec2<u32>\(0u\)/);

  const replacementHarness = makeFramebuffer();
  context._device = replacementHarness.device;
  const replacementState = framebuffer.begin(
    { x: 10, y: 10, width: 3, height: 3 },
    { x: 0, y: 0, width: 100, height: 100 },
  );
  const replacementCalls = [];
  replacementState.framebuffer.resetSnapPayloadCoverage({
    setPipeline(pipeline) {
      replacementCalls.push(["pipeline", pipeline]);
    },
    draw(vertexCount) {
      replacementCalls.push(["draw", vertexCount]);
    },
  });
  assert.equal(replacementHarness.renderPipelines.length, 1);
  assert.notEqual(replacementHarness.renderPipelines[0], renderPipelines[0]);
  assert.deepEqual(replacementCalls, [
    ["pipeline", replacementHarness.renderPipelines[0]],
    ["draw", 3],
  ]);

  framebuffer.destroy();
  replacementHarness.framebuffer.destroy();
  // The reset never owns an encoder or submission; it only records into the
  // caller's already-open, query-scissored payload pass.
  assert.equal(harness.privateEncoderCreations(), 0);
  assert.equal(harness.privateSubmissions(), 0);
});

test("overlap reuse filters A-only hits and remaps an intersection around cursor B", async () => {
  const harness = makeFramebuffer();
  const { framebuffer, buffers, callbacks, objects } = harness;
  framebuffer.end({ width: 3, height: 3 }, makeView(50));
  writeHit(buffers[0], -1, 0, 7, 10);
  writeHit(buffers[0], 1, 0, 8, 20);
  await completeSubmittedReadback(harness);

  framebuffer.begin(
    { x: 11, y: 10, width: 3, height: 3 },
    { x: 0, y: 0, width: 100, height: 100 },
  );
  const currentView = makeView(51);
  const result = framebuffer.end({ width: 3, height: 3 }, currentView);

  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].object, objects.get(8));
  assert.deepEqual([result.hits[0].x, result.hits[0].y], [0, 0]);
  assert.equal(result.view, currentView);
  callbacks.shift()(false);
  framebuffer.destroy();
});

test("an exact-region payload is cold after camera A moves to camera B", async () => {
  const harness = makeFramebuffer();
  const { framebuffer, buffers, callbacks } = harness;
  framebuffer.end({ width: 3, height: 3 }, makeView(50));
  writeHit(buffers[0], 0, 0, 7);
  await completeSubmittedReadback(harness);

  const result = framebuffer.end(
    { width: 3, height: 3 },
    makeView(50, { positionX: 1000 }),
  );
  assert.deepEqual(result.hits, []);
  callbacks.shift()(false);
  framebuffer.destroy();
});

test("an exact-region payload is cold after the far plane changes", async () => {
  const harness = makeFramebuffer();
  const { framebuffer, buffers, callbacks } = harness;
  framebuffer.end({ width: 3, height: 3 }, makeView(50));
  writeHit(buffers[0], 0, 0, 7);
  await completeSubmittedReadback(harness);

  const result = framebuffer.end(
    { width: 3, height: 3 },
    makeView(50, { far: 1000000 }),
  );
  assert.deepEqual(result.hits, []);
  callbacks.shift()(false);
  framebuffer.destroy();
});

test("an exact-region payload expires across rendered scene frames", async () => {
  const harness = makeFramebuffer();
  const { framebuffer, buffers, callbacks } = harness;
  framebuffer.end({ width: 3, height: 3 }, makeView(50));
  writeHit(buffers[0], 0, 0, 7);
  await completeSubmittedReadback(harness);

  const muchLaterFrame = makeView(50, { sceneFrameNumber: 109 });
  assert.deepEqual(
    framebuffer.end({ width: 3, height: 3 }, muchLaterFrame).hits,
    [],
  );
  callbacks.shift()(false);
  framebuffer.destroy();
});

test("a large cursor jump is cold even when the old and new apertures overlap", async () => {
  const harness = makeFramebuffer();
  const { framebuffer, buffers, callbacks } = harness;
  framebuffer.begin(
    { x: 10, y: 10, width: 7, height: 7 },
    { x: 0, y: 0, width: 100, height: 100 },
  );
  framebuffer.end({ width: 7, height: 7 }, makeView(50));
  writeHit(buffers[0], 2, 0, 7, 42, 7);
  await completeSubmittedReadback(harness);

  // The regions still overlap by four columns, but their centers moved three
  // drawing-buffer pixels. Reusing the old candidate set would omit almost
  // half of the current aperture.
  framebuffer.begin(
    { x: 13, y: 10, width: 7, height: 7 },
    { x: 0, y: 0, width: 100, height: 100 },
  );
  assert.deepEqual(
    framebuffer.end({ width: 7, height: 7 }, makeView(53)).hits,
    [],
  );
  callbacks.shift()(false);
  framebuffer.destroy();
});

test("endAsync maps only after the active frame reports submission", async () => {
  const harness = makeFramebuffer();
  const { framebuffer, buffers, callbacks, mapResolvers, objects } = harness;
  const resultPromise = framebuffer.endAsync(
    { width: 3, height: 3 },
    makeView(50),
  );

  assert.equal(harness.copies.length, 1);
  assert.equal(harness.privateEncoderCreations(), 0);
  assert.equal(harness.privateSubmissions(), 0);
  assert.equal(mapResolvers.length, 0);

  writeHit(buffers[0], 0, 0, 7);
  callbacks.shift()(true);
  assert.equal(mapResolvers.length, 1);
  mapResolvers.shift()();
  const hits = await resultPromise;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].object, objects.get(7));
  await Promise.resolve();
  assert.equal(buffers[0].destroyed, true);
  framebuffer.destroy();
});

test("an abandoned async frame settles empty and destroys its buffer", async () => {
  const harness = makeFramebuffer();
  const resultPromise = harness.framebuffer.endAsync(
    { width: 3, height: 3 },
    makeView(50),
  );
  harness.callbacks.shift()(false);

  assert.deepEqual(await resultPromise, []);
  assert.equal(harness.buffers[0].destroyed, true);
  assert.equal(harness.mapResolvers.length, 0);
  harness.framebuffer.destroy();
});
