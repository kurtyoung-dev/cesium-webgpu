import { WebGPUSnapFramebuffer } from "../../../Source/Renderer/WebGPU/WebGPUSnapFramebuffer.js";
import { packSnapDepthAndEdge } from "../../../Source/Renderer/WebGPU/WebGPUSnapPayload.js";

if (typeof globalThis.GPUTextureUsage === "undefined") {
  globalThis.GPUTextureUsage = {
    RENDER_ATTACHMENT: 0x10,
    COPY_SRC: 0x01,
  };
}
if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    COPY_DST: 0x08,
    MAP_READ: 0x01,
  };
}
if (typeof globalThis.GPUMapMode === "undefined") {
  globalThis.GPUMapMode = { READ: 0x01 };
}

function makeView(windowX, overrides = {}) {
  return Object.freeze({
    sceneFrameNumber: overrides.sceneFrameNumber ?? 100,
    windowX: windowX,
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
    positionY: overrides.positionY ?? 0,
    positionZ: overrides.positionZ ?? 0,
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

function makeDevice(options = {}) {
  const buffers = [];
  const copies = [];
  const mapResolvers = [];
  const shaderModules = [];
  const renderPipelines = [];
  const queue = {
    submissions: [],
    submit: function (commandBuffers) {
      this.submissions.push(commandBuffers);
    },
  };
  const encoder = {
    copyTextureToBuffer: function (source, destination, extent) {
      copies.push({ source: source, destination: destination, extent: extent });
    },
  };

  const device = {
    buffers: buffers,
    copies: copies,
    mapResolvers: mapResolvers,
    shaderModules: shaderModules,
    renderPipelines: renderPipelines,
    queue: queue,
    encoder: encoder,
    createTexture: function (descriptor) {
      const texture = {
        descriptor: descriptor,
        destroyed: false,
        createView: function () {
          return { texture: texture };
        },
        destroy: function () {
          this.destroyed = true;
        },
      };
      return texture;
    },
    createBuffer: function (descriptor) {
      const storage = new ArrayBuffer(descriptor.size);
      const buffer = {
        descriptor: descriptor,
        storage: storage,
        destroyed: false,
        mapped: false,
        mapAsync: function () {
          if (!options.deferMaps) {
            this.mapped = true;
            return Promise.resolve();
          }
          return new Promise((resolve) => {
            mapResolvers.push(() => {
              this.mapped = true;
              resolve();
            });
          });
        },
        getMappedRange: function () {
          return storage;
        },
        unmap: function () {
          this.mapped = false;
        },
        destroy: function () {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createShaderModule: function (descriptor) {
      const module = { descriptor: descriptor };
      shaderModules.push(module);
      return module;
    },
    createRenderPipeline: function (descriptor) {
      const pipeline = { descriptor: descriptor };
      renderPipelines.push(pipeline);
      return pipeline;
    },
    createCommandEncoder: jasmine.createSpy("createCommandEncoder"),
  };
  return device;
}

function makeFramebuffer(options = {}) {
  const device = makeDevice(options);
  const callbacks = [];
  const pickedObject = { id: "snap-hit" };
  const intersectionObject = { id: "intersection-hit" };
  const context = {
    _device: device,
    scenePipelineFormat: "rgba8unorm",
    currentCommandEncoder: device.encoder,
    beginPickFrame: jasmine.createSpy("beginPickFrame"),
    enqueueAfterFrameSubmit: function (callback) {
      callbacks.push(callback);
      return true;
    },
    getObjectByPickColor: function (key) {
      if (key === 7) {
        return pickedObject;
      }
      return key === 8 ? intersectionObject : undefined;
    },
  };
  const framebuffer = new WebGPUSnapFramebuffer(context);
  framebuffer.begin(
    { x: 10, y: 10, width: 3, height: 3 },
    { x: 0, y: 0, width: 100, height: 100 },
  );
  return {
    framebuffer,
    context,
    device,
    callbacks,
    pickedObject,
    intersectionObject,
  };
}

function writeHit(buffer, x, y, key = 7, depth = 42) {
  const words = new Uint32Array(buffer.storage);
  const wordsPerRow = 256 / 4;
  const index = (1 + y) * wordsPerRow + (1 + x) * 2;
  words[index] = key >>> 0;
  words[index + 1] = packSnapDepthAndEdge(depth, true);
}

function writeCenterHit(buffer) {
  writeHit(buffer, 0, 0);
}

async function finishSubmittedReadback(device, callbacks) {
  callbacks.shift()(true);
  device.mapResolvers.shift()();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Renderer/WebGPU/WebGPUSnapFramebuffer", function () {
  it("lazily resets covered payload with an exact-device pipeline", function () {
    const { framebuffer, context, device } = makeFramebuffer();
    const state = framebuffer.begin(
      { x: 10, y: 10, width: 3, height: 3 },
      { x: 0, y: 0, width: 100, height: 100 },
    );
    const firstPass = {
      setPipeline: jasmine.createSpy("setPipeline"),
      draw: jasmine.createSpy("draw"),
    };

    expect(device.shaderModules.length).toBe(0);
    expect(device.renderPipelines.length).toBe(0);
    state.framebuffer.resetSnapPayloadCoverage(firstPass);
    state.framebuffer.resetSnapPayloadCoverage(firstPass);

    expect(device.shaderModules.length).toBe(1);
    expect(device.renderPipelines.length).toBe(1);
    expect(firstPass.setPipeline.calls.allArgs()).toEqual([
      [device.renderPipelines[0]],
      [device.renderPipelines[0]],
    ]);
    expect(firstPass.draw.calls.allArgs()).toEqual([[3], [3]]);
    const descriptor = device.renderPipelines[0].descriptor;
    expect(descriptor.fragment.targets).toEqual([{ format: "rg32uint" }]);
    expect(descriptor.depthStencil).toEqual({
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "not-equal",
    });
    expect(device.shaderModules[0].descriptor.code).toContain(
      "vec4<f32>(positions[vertexIndex], 1.0, 1.0)",
    );
    expect(device.shaderModules[0].descriptor.code).toContain(
      "return vec2<u32>(0u)",
    );

    const replacement = makeDevice();
    context._device = replacement;
    const replacementState = framebuffer.begin(
      { x: 10, y: 10, width: 3, height: 3 },
      { x: 0, y: 0, width: 100, height: 100 },
    );
    const replacementPass = {
      setPipeline: jasmine.createSpy("replacementSetPipeline"),
      draw: jasmine.createSpy("replacementDraw"),
    };
    replacementState.framebuffer.resetSnapPayloadCoverage(replacementPass);

    expect(replacement.renderPipelines.length).toBe(1);
    expect(replacementPass.setPipeline).toHaveBeenCalledOnceWith(
      replacement.renderPipelines[0],
    );
    expect(replacement.renderPipelines[0]).not.toBe(device.renderPipelines[0]);
    framebuffer.destroy();
  });

  it("serves a coherent recent overlapping query while the cursor moves", async function () {
    spyOn(console, "warn");
    const { framebuffer, device, callbacks, pickedObject } = makeFramebuffer({
      deferMaps: true,
    });
    const firstView = makeView(50);

    expect(framebuffer.end({ width: 3, height: 3 }, firstView).hits).toEqual(
      [],
    );
    writeCenterHit(device.buffers[0]);
    await finishSubmittedReadback(device, callbacks);

    framebuffer.begin(
      { x: 11, y: 10, width: 3, height: 3 },
      { x: 0, y: 0, width: 100, height: 100 },
    );
    const currentView = makeView(51);
    const result = framebuffer.end({ width: 3, height: 3 }, currentView);

    expect(result.hits.length).toBe(1);
    expect(result.hits[0].object).toBe(pickedObject);
    expect(result.hits[0].x).toBe(-1);
    expect(result.view).toBe(currentView);
    expect(device.copies.length).toBe(2);

    // Abandon the second frame cleanly before destroying its persistent slot.
    callbacks.shift()(false);
    framebuffer.destroy();
  });

  it("filters and remaps overlapping hits around the current cursor", async function () {
    spyOn(console, "warn");
    const { framebuffer, device, callbacks, intersectionObject } =
      makeFramebuffer({ deferMaps: true });
    framebuffer.end({ width: 3, height: 3 }, makeView(50));

    // Move B one pixel right. A's left hit remaps to B x=-2 and is outside
    // B's aperture; A's right hit remaps to B center and must be the sole hit.
    writeHit(device.buffers[0], -1, 0, 7, 10);
    writeHit(device.buffers[0], 1, 0, 8, 20);
    await finishSubmittedReadback(device, callbacks);

    framebuffer.begin(
      { x: 11, y: 10, width: 3, height: 3 },
      { x: 0, y: 0, width: 100, height: 100 },
    );
    const currentView = makeView(51);
    const result = framebuffer.end({ width: 3, height: 3 }, currentView);

    expect(result.hits.length).toBe(1);
    expect(result.hits[0].object).toBe(intersectionObject);
    expect(result.hits[0].x).toBe(0);
    expect(result.hits[0].y).toBe(0);
    expect(result.view).toBe(currentView);

    callbacks.shift()(false);
    framebuffer.destroy();
  });

  it("bounds prior-query reuse by overlap and query age", async function () {
    spyOn(console, "warn");
    const { framebuffer, device, callbacks } = makeFramebuffer({
      deferMaps: true,
    });
    const firstView = makeView(50);
    framebuffer.end({ width: 3, height: 3 }, firstView);
    writeCenterHit(device.buffers[0]);
    await finishSubmittedReadback(device, callbacks);

    framebuffer.begin(
      { x: 11, y: 10, width: 3, height: 3 },
      { x: 0, y: 0, width: 100, height: 100 },
    );
    let result;
    for (let i = 1; i <= 8; i++) {
      result = framebuffer.end({ width: 3, height: 3 }, makeView(50 + i));
    }
    expect(result.hits.length).toBe(1);

    result = framebuffer.end({ width: 3, height: 3 }, makeView(59));
    expect(result.hits).toEqual([]);

    callbacks.shift()(false);
    framebuffer.destroy();

    const far = makeFramebuffer({ deferMaps: true });
    far.framebuffer.end({ width: 3, height: 3 }, firstView);
    writeCenterHit(far.device.buffers[0]);
    await finishSubmittedReadback(far.device, far.callbacks);
    far.framebuffer.begin(
      { x: 13, y: 10, width: 3, height: 3 },
      { x: 0, y: 0, width: 100, height: 100 },
    );
    expect(
      far.framebuffer.end({ width: 3, height: 3 }, makeView(53)).hits,
    ).toEqual([]);
    far.callbacks.shift()(false);
    far.framebuffer.destroy();
  });

  it("rejects a completed payload after the camera changes", async function () {
    spyOn(console, "warn");
    const { framebuffer, device, callbacks } = makeFramebuffer({
      deferMaps: true,
    });
    framebuffer.end({ width: 3, height: 3 }, makeView(50));
    writeCenterHit(device.buffers[0]);
    await finishSubmittedReadback(device, callbacks);

    // Even the exact same cursor region is not relevant after camera motion.
    const movedCamera = makeView(50, { positionX: 1000 });
    expect(framebuffer.end({ width: 3, height: 3 }, movedCamera).hits).toEqual(
      [],
    );

    callbacks.shift()(false);
    framebuffer.destroy();
  });

  it("rejects a completed payload after the far plane changes", async function () {
    spyOn(console, "warn");
    const { framebuffer, device, callbacks } = makeFramebuffer({
      deferMaps: true,
    });
    framebuffer.end({ width: 3, height: 3 }, makeView(50));
    writeCenterHit(device.buffers[0]);
    await finishSubmittedReadback(device, callbacks);

    const changedFarPlane = makeView(50, { far: 1000000 });
    expect(
      framebuffer.end({ width: 3, height: 3 }, changedFarPlane).hits,
    ).toEqual([]);

    callbacks.shift()(false);
    framebuffer.destroy();
  });

  it("rejects a completed payload after its rendered-frame freshness bound", async function () {
    spyOn(console, "warn");
    const { framebuffer, device, callbacks } = makeFramebuffer({
      deferMaps: true,
    });
    framebuffer.end({ width: 3, height: 3 }, makeView(50));
    writeCenterHit(device.buffers[0]);
    await finishSubmittedReadback(device, callbacks);

    const muchLaterFrame = makeView(50, { sceneFrameNumber: 109 });
    expect(
      framebuffer.end({ width: 3, height: 3 }, muchLaterFrame).hits,
    ).toEqual([]);
    callbacks.shift()(false);
    framebuffer.destroy();
  });

  it("records async copy on the active encoder and maps only after submit", async function () {
    const { framebuffer, device, callbacks, pickedObject } = makeFramebuffer({
      deferMaps: true,
    });
    const promise = framebuffer.endAsync({ width: 3, height: 3 }, makeView(50));

    expect(device.copies.length).toBe(1);
    expect(device.queue.submissions).toEqual([]);
    expect(device.createCommandEncoder).not.toHaveBeenCalled();
    expect(device.mapResolvers.length).toBe(0);

    writeCenterHit(device.buffers[0]);
    callbacks.shift()(true);
    expect(device.mapResolvers.length).toBe(1);
    device.mapResolvers.shift()();
    const hits = await promise;

    expect(hits.length).toBe(1);
    expect(hits[0].object).toBe(pickedObject);
    await Promise.resolve();
    expect(device.buffers[0].destroyed).toBe(true);
    framebuffer.destroy();
  });

  it("settles and destroys an async request when its frame is abandoned", async function () {
    const { framebuffer, device, callbacks } = makeFramebuffer({
      deferMaps: true,
    });
    const promise = framebuffer.endAsync({ width: 3, height: 3 }, makeView(50));

    callbacks.shift()(false);
    expect(await promise).toEqual([]);
    expect(device.buffers[0].destroyed).toBe(true);
    expect(device.mapResolvers.length).toBe(0);
    framebuffer.destroy();
  });
});
