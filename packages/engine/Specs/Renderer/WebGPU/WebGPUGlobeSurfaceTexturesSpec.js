import GlobeSurfaceTile from "../../../Source/Scene/GlobeSurfaceTile.js";
import {
  getOrCreateWaterMaskTexture,
  uploadImageSource,
} from "../../../Source/Renderer/WebGPU/WebGPUGlobeSurfaceTextures.js";
import GlobeTerrainSource from "../../../Source/Shaders/WebGPU/Globe/GlobeTerrain.js";

describe("Renderer/WebGPU/WebGPUGlobeSurfaceTextures", function () {
  function createHost(device) {
    return {
      _device: device,
      _imageryTextureCache: new Map(),
      _waterMaskTextureCache: new Map(),
      _diagShouldLog: function () {
        return false;
      },
    };
  }

  function createDevice() {
    const view = {};
    const texture = {
      createView: jasmine.createSpy("createView").and.returnValue(view),
      destroy: jasmine.createSpy("destroy"),
    };
    return {
      device: {
        createTexture: jasmine
          .createSpy("createTexture")
          .and.returnValue(texture),
        queue: {
          writeTexture: jasmine.createSpy("writeTexture"),
          copyExternalImageToTexture: jasmine.createSpy(
            "copyExternalImageToTexture",
          ),
        },
      },
      texture,
      view,
    };
  }

  it("borrows the Texture stub's same-device native realization", function () {
    const fake = createDevice();
    const nativeTexture = {};
    const nativeView = {};
    const waterMask = {
      _id: "native",
      _context: { device: fake.device },
      _texture: {
        _webgpuTexture: {
          texture: nativeTexture,
          view: nativeView,
        },
      },
      _webgpuSource: {
        width: 2,
        height: 2,
        arrayBufferView: new Uint8Array([1, 2, 3, 4]),
      },
    };
    const host = createHost(fake.device);

    expect(getOrCreateWaterMaskTexture(host, waterMask)).toBe(nativeView);
    expect(getOrCreateWaterMaskTexture(host, waterMask)).toBe(nativeView);
    expect(fake.device.createTexture).not.toHaveBeenCalled();
    expect(fake.device.queue.writeTexture).not.toHaveBeenCalled();
    expect(fake.device.queue.copyExternalImageToTexture).not.toHaveBeenCalled();
    expect(host._waterMaskTextureCache.size).toBe(0);
    expect(waterMask._webgpuTextureCacheCleanup).toBeUndefined();
  });

  it("leaves same-device native destruction solely to Texture refcount ownership", function () {
    const fake = createDevice();
    const nativeDestroy = jasmine.createSpy("nativeDestroy");
    const waterMask = {
      _id: "owned",
      _context: { device: fake.device },
      _texture: {
        _webgpuTexture: {
          texture: {},
          view: {},
          destroy: nativeDestroy,
        },
      },
      referenceCount: 1,
      destroy: function () {
        this._texture._webgpuTexture.destroy();
      },
    };
    const host = createHost(fake.device);
    const tile = new GlobeSurfaceTile();
    tile.waterMaskTexture = waterMask;

    getOrCreateWaterMaskTexture(host, waterMask);
    tile.freeResources();

    expect(waterMask.referenceCount).toBe(0);
    expect(tile.waterMaskTexture).toBeUndefined();
    expect(waterMask._webgpuTextureCacheCleanup).toBeUndefined();
    expect(nativeDestroy).toHaveBeenCalledTimes(1);
  });

  it("keeps cross-device fallback rows unchanged and destroys only its owned copy", function () {
    const fake = createDevice();
    const source = new Uint8Array([11, 12, 21, 22]);
    const foreignDestroy = jasmine.createSpy("foreignDestroy");
    const waterMask = {
      _id: "cross-device",
      _context: { device: {} },
      _texture: {
        _webgpuTexture: {
          texture: {},
          view: {},
          destroy: foreignDestroy,
        },
      },
      _webgpuSource: {
        width: 2,
        height: 2,
        arrayBufferView: source,
      },
    };
    const host = createHost(fake.device);

    expect(getOrCreateWaterMaskTexture(host, waterMask)).toBe(fake.view);
    expect(fake.device.createTexture).toHaveBeenCalledTimes(1);
    expect(fake.device.queue.writeTexture).toHaveBeenCalledTimes(1);
    const write = fake.device.queue.writeTexture.calls.mostRecent().args;
    expect(write[1]).toBe(source);
    expect(Array.from(write[1])).toEqual([11, 12, 21, 22]);
    expect(host._waterMaskTextureCache.size).toBe(1);

    waterMask._webgpuTextureCacheCleanup();
    waterMask._webgpuTextureCacheCleanup();
    expect(host._waterMaskTextureCache.size).toBe(0);
    expect(fake.texture.destroy).toHaveBeenCalledTimes(1);
    expect(foreignDestroy).not.toHaveBeenCalled();
  });

  it("preserves external-image row order in the fallback upload", function () {
    const fake = createDevice();
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const waterMask = {
      _id: "canvas",
      _context: { device: {} },
      _webgpuSource: canvas,
    };

    getOrCreateWaterMaskTexture(createHost(fake.device), waterMask);

    expect(fake.device.queue.copyExternalImageToTexture).toHaveBeenCalledTimes(
      1,
    );
    const sourceDescriptor =
      fake.device.queue.copyExternalImageToTexture.calls.mostRecent().args[0];
    expect(sourceDescriptor.source).toBe(canvas);
    expect(sourceDescriptor.flipY).toBe(false);
  });

  it("cancels and destroys an enqueued candidate when view publication fails", function () {
    const events = [];
    const texture = {
      createView: function () {
        events.push("view");
        throw new Error("synthetic view failure");
      },
      destroy: function () {
        events.push("destroy");
      },
    };
    const device = {
      createTexture: jasmine
        .createSpy("createTexture")
        .and.returnValue(texture),
      queue: {
        copyExternalImageToTexture: jasmine.createSpy(
          "copyExternalImageToTexture",
        ),
      },
    };
    const context = {
      enqueueTextureMipGeneration: function (candidate) {
        expect(candidate).toBe(texture);
        events.push("enqueue");
      },
      cancelTextureMipGeneration: function (candidate) {
        expect(candidate).toBe(texture);
        events.push("cancel");
      },
      scheduleTextureDestroy: function () {},
    };
    const host = createHost(device);
    host._webgpuContext = context;
    const source = document.createElement("canvas");
    source.width = 4;
    source.height = 4;
    const cache = new Map();
    spyOn(console, "error");

    expect(uploadImageSource(host, source, "rollback", cache)).toBeNull();

    expect(events).toEqual(["enqueue", "view", "cancel", "destroy"]);
    expect(cache.size).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("applies WebGL's post-translation water-mask Y flip at both WGSL sample sites", function () {
    const flip =
      "let waterUV = vec2<f32>(waterUVUnflipped.x, 1.0 - waterUVUnflipped.y);";
    expect(GlobeTerrainSource.split(flip).length - 1).toBe(2);
  });
});
