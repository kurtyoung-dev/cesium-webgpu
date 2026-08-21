// @purpose Fake-device coverage of WebGPUPickFramebuffer/PickPass readback identity: map/unmap lifecycle, per-identity pixel decode, voxel pick pins.
// @status ACTIVE

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const FRAMEBUFFER_PATH = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts",
);
const PICK_PASS_PATH = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPickPass.ts",
);
const SCENE_PATH = path.join(ROOT, "packages/engine/Source/Scene/Scene.js");
const PICKING_PATH = path.join(ROOT, "packages/engine/Source/Scene/Picking.js");
const VOXEL_PRIMITIVE_PATH = path.join(
  ROOT,
  "packages/engine/Source/Scene/VoxelPrimitive.js",
);
const VOXEL_RENDERER_PATH = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts",
);

globalThis.GPUTextureUsage ??= {
  RENDER_ATTACHMENT: 1,
  COPY_SRC: 2,
  TEXTURE_BINDING: 4,
  COPY_DST: 8,
};
globalThis.GPUBufferUsage ??= { COPY_DST: 1, MAP_READ: 2 };
globalThis.GPUMapMode ??= { READ: 1 };

class FakeBuffer {
  constructor(events) {
    this.events = events;
    this.bytes = new Uint8Array(256);
    this.destroyed = false;
    this.promise = new Promise((resolve, reject) => {
      this.resolveMap = resolve;
      this.rejectMap = reject;
    });
  }

  mapAsync() {
    this.events.push("map");
    return this.promise;
  }

  resolve(bytes) {
    this.bytes.set(bytes);
    this.resolveMap();
  }

  getMappedRange() {
    return this.bytes.buffer;
  }

  unmap() {}

  destroy() {
    this.destroyed = true;
  }
}

class FakeDevice {
  constructor(label) {
    this.label = label;
    this.events = [];
    this.renderPassDescriptors = [];
    this.buffers = [];
    this.textures = [];
    this.queue = {
      submit: (commandBuffers) => {
        this.events.push(
          `submit:${commandBuffers.map((buffer) => buffer.label).join(",")}`,
        );
      },
      writeTexture() {},
    };
  }

  createTexture(descriptor) {
    const texture = {
      descriptor,
      destroyed: false,
      createView() {
        return { texture };
      },
      destroy() {
        texture.destroyed = true;
      },
    };
    this.textures.push(texture);
    return texture;
  }

  createBuffer() {
    const buffer = new FakeBuffer(this.events);
    this.buffers.push(buffer);
    return buffer;
  }

  createCommandEncoder(descriptor = {}) {
    const label = descriptor.label ?? "unlabelled";
    return {
      copyTextureToBuffer: () => {
        this.events.push(`copy:${label}`);
      },
      beginRenderPass: (renderPassDescriptor) => {
        this.renderPassDescriptors.push(renderPassDescriptor);
        for (const attachment of renderPassDescriptor.colorAttachments ?? []) {
          const texture = attachment?.view?.texture;
          if (attachment?.loadOp === "clear" && texture?.bytes) {
            const clear = attachment.clearValue;
            texture.bytes.set([
              Math.round(clear.r * 255),
              Math.round(clear.g * 255),
              Math.round(clear.b * 255),
              Math.round(clear.a * 255),
            ]);
          }
        }
        return {
          setViewport() {},
          setScissorRect() {},
          end() {},
        };
      },
      finish() {
        return { label };
      },
    };
  }
}

const modulePromise = build({
  entryPoints: [FRAMEBUFFER_PATH],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
}).then(({ outputFiles }) => {
  const encoded = Buffer.from(outputFiles[0].text).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
});

const pickPassModulePromise = build({
  entryPoints: [PICK_PASS_PATH],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
}).then(({ outputFiles }) => {
  const encoded = Buffer.from(outputFiles[0].text).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
});

function createHarness(label = "device-a") {
  const device = new FakeDevice(label);
  let currentCommandEncoder = null;
  let afterFrameSubmitCallbacks = [];
  const context = {
    _device: device,
    resourceGeneration: 1,
    pickPipelineFormat: "rgba8unorm",
    scenePipelineFormat: "rgba8unorm",
    uniformState: {},
    _currentRenderPassEncoder: null,
    _pickClassificationDepthView: null,
    beginPickFrame() {
      currentCommandEncoder ??= device.createCommandEncoder({
        label: "pick-frame",
      });
    },
    get currentCommandEncoder() {
      return currentCommandEncoder;
    },
    get _currentCommandEncoder() {
      return currentCommandEncoder;
    },
    set _currentCommandEncoder(value) {
      currentCommandEncoder = value;
    },
    endCurrentRenderPass() {
      this._currentRenderPassEncoder?.end();
      this._currentRenderPassEncoder = null;
    },
    withRenderPassTimestamps(descriptor) {
      return descriptor;
    },
    enqueueAfterFrameSubmit(callback) {
      if (!currentCommandEncoder) {
        return false;
      }
      afterFrameSubmitCallbacks.push(callback);
      return true;
    },
    endFrame() {
      const encoder = currentCommandEncoder;
      if (!encoder) {
        return;
      }
      currentCommandEncoder = null;
      device.queue.submit([encoder.finish()]);
      const callbacks = afterFrameSubmitCallbacks;
      afterFrameSubmitCallbacks = [];
      for (const callback of callbacks) {
        callback(true);
      }
    },
  };
  return { context, device };
}

function createPickLifecycle(context) {
  return {
    device: context._device,
    resourceGeneration: context.resourceGeneration,
    atlasReuseEpoch: 0,
    contentRevision: 0,
    detached: false,
  };
}

const rectangle = { x: 20, y: 20, width: 3, height: 3 };
const viewport = { x: 0, y: 0, width: 64, height: 64 };

async function flushCompletions() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("voxel pass owns an impossible no-fragment clear and cold is invalid", async () => {
  const { WebGPUPickFramebuffer } = await modulePromise;
  const { context, device } = createHarness();
  const framebuffer = new WebGPUPickFramebuffer(context);
  const lifecycle = createPickLifecycle(context);
  const owner = {};

  const passState = framebuffer.begin(rectangle, viewport, "voxel");
  assert.deepEqual(passState.framebuffer.pickClearValue, {
    r: 1,
    g: 1,
    b: 1,
    a: 1,
  });
  assert.equal(
    framebuffer.readCenterPixel(
      rectangle,
      "voxel",
      owner,
      lifecycle,
      lifecycle.atlasReuseEpoch,
    ),
    undefined,
    "a cold read must not fabricate the valid root/sample-zero bytes",
  );

  // A no-command/no-fragment pass resolves to the framebuffer's all-255 clear.
  device.buffers.at(-1).resolve([255, 255, 255, 255]);
  await flushCompletions();
  framebuffer.begin(rectangle, viewport, "voxel");
  assert.deepEqual(
    Array.from(
      framebuffer.readCenterPixel(
        rectangle,
        "voxel",
        owner,
        lifecycle,
        lifecycle.atlasReuseEpoch,
      ),
    ),
    [255, 255, 255, 255],
  );

  // Zero is not a sentinel. It round-trips as a valid root/sample-zero hit.
  device.buffers.at(-1).resolve([0, 0, 0, 0]);
  await flushCompletions();
  framebuffer.begin(rectangle, viewport, "voxel");
  assert.deepEqual(
    Array.from(
      framebuffer.readCenterPixel(
        rectangle,
        "voxel",
        owner,
        lifecycle,
        lifecycle.atlasReuseEpoch,
      ),
    ),
    [0, 0, 0, 0],
  );

  framebuffer.begin(rectangle, viewport, "metadata");
  assert.equal(passState.framebuffer.pickClearValue, undefined);

  const pickPassSource = readFileSync(PICK_PASS_PATH, "utf8");
  assert.match(
    pickPassSource,
    /clearValue: pickFBO\.pickClearValue \?\? DEFAULT_PICK_CLEAR_VALUE/,
  );
  const sceneSource = readFileSync(SCENE_PATH, "utf8");
  assert.match(
    sceneSource,
    /voxelCoordinate\[0\] === 255[\s\S]*?voxelCoordinate\[3\] === 255/,
  );
});

test("per-identity slots never cross-serve and serve their own bytes within the staleness window", async () => {
  const { WebGPUPickFramebuffer } = await modulePromise;
  const { context, device } = createHarness();
  const framebuffer = new WebGPUPickFramebuffer(context);
  const classA = {};
  const propertyA = {};
  const classB = {};
  const propertyB = {};
  const pickedA = {};
  const pickedB = {};
  const owner = {};
  const lifecycle = createPickLifecycle(context);

  framebuffer.begin(rectangle, viewport, "metadata");
  assert.equal(
    framebuffer.readCenterPixel(
      rectangle,
      "metadata",
      classA,
      propertyA,
      "schema-a\0class-a\0property-a",
      pickedA,
    ),
    undefined,
  );
  const requestA = device.buffers.at(-1);

  framebuffer.begin(rectangle, viewport, "metadata");
  framebuffer.readCenterPixel(
    rectangle,
    "metadata",
    classB,
    propertyB,
    "schema-b\0class-b\0property-b",
    pickedB,
  );
  const requestB = device.buffers.at(-1);

  framebuffer.begin(rectangle, viewport, "voxel");
  framebuffer.readCenterPixel(
    rectangle,
    "voxel",
    owner,
    lifecycle,
    lifecycle.atlasReuseEpoch,
  );
  const requestVoxel = device.buffers.at(-1);

  requestA.resolve([10, 11, 12, 13]);
  requestB.resolve([20, 21, 22, 23]);
  requestVoxel.resolve([30, 31, 32, 33]);
  await flushCompletions();

  framebuffer.begin(rectangle, viewport, "voxel");
  assert.deepEqual(
    Array.from(
      framebuffer.readCenterPixel(
        rectangle,
        "voxel",
        owner,
        lifecycle,
        lifecycle.atlasReuseEpoch,
      ),
    ),
    [30, 31, 32, 33],
    "the voxel query must serve its own identity slot",
  );

  // A was stamped at pick 1, so this fifth begin deliberately serves it at
  // age 4: the inclusive CENTER_PIXEL_MAX_STALE_FRAMES boundary.
  framebuffer.begin(rectangle, viewport, "metadata");
  const metadataABytes = framebuffer.readCenterPixel(
    rectangle,
    "metadata",
    classA,
    propertyA,
    "schema-a\0class-a\0property-a",
    pickedA,
  );
  const metadataAArray =
    metadataABytes === undefined ? undefined : Array.from(metadataABytes);
  assert.notDeepEqual(
    metadataAArray,
    [20, 21, 22, 23],
    "metadata A must never serve metadata B's bytes",
  );
  assert.notDeepEqual(
    metadataAArray,
    [30, 31, 32, 33],
    "metadata A must never serve voxel bytes",
  );
  assert.deepEqual(
    metadataAArray,
    [10, 11, 12, 13],
    "metadata A must serve its own slot at the inclusive age-4 boundary",
  );

  framebuffer.begin(rectangle, viewport, "metadata");
  assert.deepEqual(
    Array.from(
      framebuffer.readCenterPixel(
        rectangle,
        "metadata",
        classB,
        propertyB,
        "schema-b\0class-b\0property-b",
        pickedB,
      ),
    ),
    [20, 21, 22, 23],
    "metadata B must serve its own identity slot",
  );

  for (let i = 0; i < 5; i++) {
    framebuffer.begin(rectangle, viewport, "metadata");
  }
  const staleDeclinesBefore =
    framebuffer.getStatistics().centerPixel.declines["stale-beyond-max"];
  framebuffer.begin(rectangle, viewport, "metadata");
  assert.equal(
    framebuffer.readCenterPixel(
      rectangle,
      "metadata",
      classA,
      propertyA,
      "schema-a\0class-a\0property-a",
      pickedA,
    ),
    undefined,
    "metadata A must decline after more than CENTER_PIXEL_MAX_STALE_FRAMES further begins",
  );
  assert.equal(
    framebuffer.getStatistics().centerPixel.declines["stale-beyond-max"],
    staleDeclinesBefore + 1,
    "the aged metadata A slot must decline specifically as stale-beyond-max",
  );
});

test("view and voxel-content motion fail closed while an unchanged view warms", async () => {
  const { WebGPUPickFramebuffer } = await modulePromise;
  const { context, device } = createHarness();
  const framebuffer = new WebGPUPickFramebuffer(context);
  const owner = {};
  const lifecycle = createPickLifecycle(context);

  framebuffer.begin(rectangle, viewport, "voxel");
  assert.equal(
    framebuffer.readCenterPixel(
      rectangle,
      "voxel",
      owner,
      lifecycle,
      lifecycle.atlasReuseEpoch,
      lifecycle.contentRevision,
      "view-a",
    ),
    undefined,
  );
  device.buffers.at(-1).resolve([1, 2, 3, 4]);
  await flushCompletions();

  framebuffer.begin(rectangle, viewport, "voxel");
  assert.equal(
    framebuffer.readCenterPixel(
      rectangle,
      "voxel",
      owner,
      lifecycle,
      lifecycle.atlasReuseEpoch,
      lifecycle.contentRevision,
      "view-b",
    ),
    undefined,
    "bytes rendered by a different camera/projection provenance must not leak",
  );
  device.buffers.at(-1).resolve([5, 6, 7, 8]);
  await flushCompletions();

  framebuffer.begin(rectangle, viewport, "voxel");
  assert.deepEqual(
    Array.from(
      framebuffer.readCenterPixel(
        rectangle,
        "voxel",
        owner,
        lifecycle,
        lifecycle.atlasReuseEpoch,
        lifecycle.contentRevision,
        "view-b",
      ),
    ),
    [5, 6, 7, 8],
    "an unchanged continuously-rendered view must retain warm-cache behavior",
  );

  const preContentChange = device.buffers.at(-1);
  lifecycle.contentRevision++;
  preContentChange.resolve([9, 10, 11, 12]);
  await flushCompletions();
  framebuffer.begin(rectangle, viewport, "voxel");
  assert.equal(
    framebuffer.readCenterPixel(
      rectangle,
      "voxel",
      owner,
      lifecycle,
      lifecycle.atlasReuseEpoch,
      lifecycle.contentRevision,
      "view-b",
    ),
    undefined,
    "an in-flight completion from an older atlas content revision must be rejected",
  );
});

test("resize, resource recovery, and atlas reuse reject delayed completion", async () => {
  const { WebGPUPickFramebuffer } = await modulePromise;
  const { context, device } = createHarness();
  const framebuffer = new WebGPUPickFramebuffer(context);
  const owner = {};
  let lifecycle = createPickLifecycle(context);

  framebuffer.begin(rectangle, viewport, "voxel");
  framebuffer.readCenterPixel(
    rectangle,
    "voxel",
    owner,
    lifecycle,
    lifecycle.atlasReuseEpoch,
  );
  const preRecovery = device.buffers.at(-1);

  context.resourceGeneration = 2;
  lifecycle = createPickLifecycle(context);
  framebuffer.begin(
    rectangle,
    { ...viewport, width: viewport.width + 1 },
    "voxel",
  );
  framebuffer.readCenterPixel(
    rectangle,
    "voxel",
    owner,
    lifecycle,
    lifecycle.atlasReuseEpoch,
  );
  const postRecovery = device.buffers.at(-1);

  preRecovery.resolve([1, 2, 3, 4]);
  postRecovery.resolve([5, 6, 7, 8]);
  await flushCompletions();
  framebuffer.begin(
    rectangle,
    { ...viewport, width: viewport.width + 1 },
    "voxel",
  );
  assert.deepEqual(
    Array.from(
      framebuffer.readCenterPixel(
        rectangle,
        "voxel",
        owner,
        lifecycle,
        lifecycle.atlasReuseEpoch,
      ),
    ),
    [5, 6, 7, 8],
  );

  // Reassignment invalidates the just-armed old-epoch request immediately;
  // the first completed request captured with the new epoch is accepted.
  const oldEpochRequest = device.buffers.at(-1);
  lifecycle.atlasReuseEpoch++;
  oldEpochRequest.resolve([9, 9, 9, 9]);
  await flushCompletions();
  framebuffer.begin(
    rectangle,
    { ...viewport, width: viewport.width + 1 },
    "voxel",
  );
  assert.equal(
    framebuffer.readCenterPixel(
      rectangle,
      "voxel",
      owner,
      lifecycle,
      lifecycle.atlasReuseEpoch,
    ),
    undefined,
  );
  const matchingEpochRequest = device.buffers.at(-1);
  matchingEpochRequest.resolve([40, 41, 42, 43]);
  await flushCompletions();
  framebuffer.begin(
    rectangle,
    { ...viewport, width: viewport.width + 1 },
    "voxel",
  );
  assert.deepEqual(
    Array.from(
      framebuffer.readCenterPixel(
        rectangle,
        "voxel",
        owner,
        lifecycle,
        lifecycle.atlasReuseEpoch,
      ),
    ),
    [40, 41, 42, 43],
  );

  const preDeviceSwap = device.buffers.at(-1);
  const replacementDevice = new FakeDevice("device-b");
  context._device = replacementDevice;
  lifecycle = createPickLifecycle(context);
  framebuffer.begin(
    rectangle,
    { ...viewport, width: viewport.width + 1 },
    "voxel",
  );
  assert.equal(
    framebuffer.readCenterPixel(
      rectangle,
      "voxel",
      owner,
      lifecycle,
      lifecycle.atlasReuseEpoch,
    ),
    undefined,
  );
  const postDeviceSwap = replacementDevice.buffers.at(-1);
  preDeviceSwap.resolve([50, 51, 52, 53]);
  postDeviceSwap.resolve([60, 61, 62, 63]);
  await flushCompletions();
  framebuffer.begin(
    rectangle,
    { ...viewport, width: viewport.width + 1 },
    "voxel",
  );
  assert.deepEqual(
    Array.from(
      framebuffer.readCenterPixel(
        rectangle,
        "voxel",
        owner,
        lifecycle,
        lifecycle.atlasReuseEpoch,
      ),
    ),
    [60, 61, 62, 63],
  );
});

test("ordinary object-pick cache identity includes resource generation", () => {
  const source = readFileSync(FRAMEBUFFER_PATH, "utf8");
  assert.match(
    source,
    /interface PickReadbackRegion[\s\S]*?resourceGeneration: number/,
  );
  assert.match(
    source,
    /left\.resourceGeneration === right\.resourceGeneration/,
  );
  assert.match(
    source,
    /cached\.resourceGeneration !== region\.resourceGeneration/,
  );
  assert.match(
    source,
    /this\._attachmentResourceGeneration !== region\.resourceGeneration/,
  );
});

test("zero-frustum object and voxel passes clear stale attachment bytes", async () => {
  const { executePickPass } = await pickPassModulePromise;
  const { context } = createHarness();
  const colorTexture = { bytes: new Uint8Array([7, 8, 9, 10]) };
  const pickFramebuffer = {
    _isWebGPUPickFBO: true,
    colorView: { texture: colorTexture },
    depthView: {},
    width: viewport.width,
    height: viewport.height,
    pickScissor: { x: 20, y: 20, width: 1, height: 1 },
  };
  const passes = { pick: true, pickVoxel: false };
  const frameState = { passes };
  const scene = {
    _view: { frustumCommandsList: [] },
    frameState,
    _frameState: frameState,
  };
  const passState = {
    framebuffer: pickFramebuffer,
    viewport,
    scissorTest: {
      enabled: true,
      rectangle: { x: 20, y: 20, width: 1, height: 1 },
    },
  };

  executePickPass({}, { scene, context, passState });
  assert.deepEqual(
    Array.from(colorTexture.bytes),
    [0, 0, 0, 0],
    "an empty ordinary pick must erase the previous object's ID",
  );
  context.endFrame();

  colorTexture.bytes.set([21, 22, 23, 24]);
  passes.pick = false;
  passes.pickVoxel = true;
  pickFramebuffer.pickClearValue = { r: 1, g: 1, b: 1, a: 1 };
  executePickPass({}, { scene, context, passState });
  assert.deepEqual(
    Array.from(colorTexture.bytes),
    [255, 255, 255, 255],
    "an empty voxel-coordinate pass must publish only its impossible sentinel",
  );
  context.endFrame();
});

test("camera motion cannot reuse voxel A as the selected owner for voxel B", async () => {
  const { WebGPUPickFramebuffer } = await modulePromise;
  const { context, device } = createHarness();
  const voxelA = { name: "voxel-a" };
  const voxelB = { name: "voxel-b" };
  const pickedA = { primitive: voxelA };
  const pickedB = { primitive: voxelB };
  context.getObjectByPickColor = (key) =>
    key === 1 ? pickedA : key === 2 ? pickedB : undefined;
  const framebuffer = new WebGPUPickFramebuffer(context);
  const onePixel = { x: 20, y: 20, width: 1, height: 1 };

  framebuffer.begin(onePixel, viewport, undefined, "camera-a");
  assert.deepEqual(framebuffer.end(onePixel), []);
  const requestA = device.buffers.at(-1);
  context.endFrame();

  // Move to the view where B is visible before A's submitted copy maps. The
  // in-flight A request prevents an overlapping B copy, but it must still be
  // rejected rather than published under B's provenance.
  framebuffer.begin(onePixel, viewport, undefined, "camera-b");
  assert.deepEqual(
    framebuffer.end(onePixel),
    [],
    "a moved view must fail closed instead of selecting stale voxel A",
  );
  context.endFrame();
  requestA.resolve([1, 0, 0, 0]);
  await flushCompletions();

  // With A drained, arm and complete B's own exact draw+copy submission.
  framebuffer.begin(onePixel, viewport, undefined, "camera-b");
  assert.deepEqual(framebuffer.end(onePixel), []);
  const requestB = device.buffers.at(-1);
  context.endFrame();
  requestB.resolve([2, 0, 0, 0]);
  await flushCompletions();

  framebuffer.begin(onePixel, viewport, undefined, "camera-b");
  assert.equal(
    framebuffer.end(onePixel)[0],
    pickedB,
    "the unchanged B view must warm normally after its own readback completes",
  );
  context.endFrame();

  const pickPassSource = readFileSync(PICK_PASS_PATH, "utf8");
  const pickingSource = readFileSync(PICKING_PATH, "utf8");
  const primitiveSource = readFileSync(VOXEL_PRIMITIVE_PATH, "utf8");
  const rendererSource = readFileSync(VOXEL_RENDERER_PATH, "utf8");
  assert.match(
    pickingSource,
    /frameState\._pickVoxelPrimitive = voxelPrimitive[\s\S]*?finally \{[\s\S]*?frameState\._pickVoxelPrimitive = undefined/,
  );
  assert.match(
    primitiveSource,
    /frameState\.passes\.pickVoxel[\s\S]*?frameState\._pickVoxelPrimitive !== this[\s\S]*?return/,
  );
  assert.match(rendererSource, /_voxelPickOwner = cache\.owner/);
  assert.match(pickPassSource, /dispatchedVoxelOwner === selectedVoxelOwner/);
});

test("ordinary sync pick copies and maps only with the submitted pick frame", async () => {
  const { WebGPUPickFramebuffer } = await modulePromise;
  const { context, device } = createHarness();
  const framebuffer = new WebGPUPickFramebuffer(context);
  const onePixel = { x: 20, y: 20, width: 1, height: 1 };

  framebuffer.begin(onePixel, viewport, undefined, "camera-a");
  device.events.length = 0;
  assert.deepEqual(framebuffer.end(onePixel), []);
  assert.deepEqual(
    device.events,
    ["copy:pick-frame"],
    "end() may encode the copy but must neither private-submit nor map early",
  );

  context.endFrame();
  assert.deepEqual(
    device.events,
    ["copy:pick-frame", "submit:pick-frame", "map"],
    "the map must begin only after the draw+copy frame submission",
  );
  device.buffers.at(-1).resolve([1, 0, 0, 0]);
  await flushCompletions();
});

test("the actual WGSL base-255 pack cannot produce the all-255 sentinel", () => {
  const rendererSource = readFileSync(VOXEL_RENDERER_PATH, "utf8");
  assert.match(
    rendererSource,
    /fn packVoxelIntToVec2\(value: f32\)[\s\S]*?let shifted = value \/ 255\.0;[\s\S]*?vec2<f32>\(floor\(shifted\) \/ 255\.0, fract\(shifted\)\)/,
  );

  // Exhaust the exact supported base-255 integer domain used by the shader.
  for (let value = 0; value < 255 * 255; value++) {
    const shifted = Math.fround(value / 255);
    const high = Math.round(Math.fround(Math.floor(shifted) / 255) * 255);
    const low = Math.round((shifted - Math.floor(shifted)) * 255);
    assert.ok(high >= 0 && high <= 254);
    assert.ok(low >= 0 && low <= 254);
    assert.notDeepEqual([high, low, high, low], [255, 255, 255, 255]);
  }
});
