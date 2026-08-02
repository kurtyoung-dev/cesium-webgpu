import GraphicsContext from "../../../Source/Renderer/GraphicsContext.js";
import { WebGPUContext } from "../../../Source/Renderer/WebGPU/WebGPUContext.js";
import { WebGPUDevicePool } from "../../../Source/Renderer/WebGPU/WebGPUDevicePool.js";

function createBareContext(device, deviceFromPool) {
  const canvas = {
    id: "transactional-destroy-test-canvas",
    width: 16,
    height: 16,
    getContext: function () {
      return null;
    },
  };
  const context = new WebGPUContext(canvas, {});
  context._device = device;
  context._deviceFromPool = deviceFromPool;
  return context;
}

describe("Renderer/WebGPU/WebGPUContext transactional initialization", function () {
  it("FAR-103 rolls back registry, pool, listeners, canvas, and textures on late init failure", async function () {
    const registry = GraphicsContext.registry;
    const registryCountBefore = registry.count;
    const registryEvents = [];
    const removeRegistryListener = registry.addListener(
      function (event, context) {
        registryEvents.push({ event: event, context: context });
      },
    );

    const rawTextures = [];
    const fakeDevice = {
      features: new Set(),
      limits: {
        maxTextureDimension2D: 8192,
        maxSampledTexturesPerShaderStage: 16,
        maxVertexAttributes: 16,
        maxColorAttachments: 8,
        maxTextureDimension3D: 2048,
        maxTextureArrayLayers: 256,
      },
      queue: {
        writeTexture: jasmine.createSpy("writeTexture"),
      },
      createShaderModule: function () {
        throw new Error("not expected during initialization");
      },
      createTexture: function (descriptor) {
        const texture = {
          descriptor: descriptor,
          destroy: jasmine.createSpy("texture.destroy"),
          createView: function () {
            return {};
          },
        };
        rawTextures.push(texture);
        return texture;
      },
      destroy: jasmine.createSpy("device.destroy"),
    };
    Object.defineProperty(fakeDevice, "lost", {
      get: function () {
        // This is the final initialization stage, after default textures and
        // feature registration, so it exercises a genuinely late rollback.
        throw new Error("forced device-listener installation failure");
      },
    });
    const originalCreateShaderModule = fakeDevice.createShaderModule;

    const fakeAdapter = {
      info: { vendor: "transaction-test" },
    };
    const pool = WebGPUDevicePool.instance;
    spyOn(pool, "acquireDevice").and.returnValue(
      Promise.resolve({
        adapter: fakeAdapter,
        device: fakeDevice,
        isShared: false,
      }),
    );
    const teardownOrder = [];
    const releaseDevice = spyOn(pool, "releaseDevice").and.callFake(
      function () {
        teardownOrder.push("release-device");
      },
    );

    const gpuCanvasContext = {
      configure: jasmine.createSpy("configure"),
      unconfigure: jasmine.createSpy("unconfigure").and.callFake(function () {
        teardownOrder.push("unconfigure-canvas");
        throw new Error("late canvas unconfigure failure");
      }),
    };
    const canvas = {
      id: "transaction-test-canvas",
      width: 16,
      height: 16,
      getContext: function (type) {
        return type === "webgpu" ? gpuCanvasContext : null;
      },
    };

    try {
      await expectAsync(WebGPUContext.create(canvas)).toBeRejectedWithError(
        /forced device-listener installation failure/,
      );

      expect(registry.count).toBe(registryCountBefore);
      expect(registryEvents.length).toBe(0);
      expect(releaseDevice).toHaveBeenCalledOnceWith(fakeDevice);
      expect(rawTextures.length).toBe(4);
      for (const texture of rawTextures) {
        expect(texture.destroy).toHaveBeenCalledTimes(1);
      }
      expect(gpuCanvasContext.unconfigure).toHaveBeenCalledTimes(1);
      expect(teardownOrder).toEqual(["unconfigure-canvas", "release-device"]);
      expect(fakeDevice.createShaderModule).toBe(originalCreateShaderModule);
    } finally {
      removeRegistryListener();
    }
  });

  it("continues pooled teardown after allocator cleanup throws", function () {
    const firstCleanupError = new Error("uniform allocator cleanup failed");
    const laterCleanupError = new Error("shader validation cleanup failed");
    const device = {
      destroy: jasmine.createSpy("device.destroy"),
    };
    const pool = WebGPUDevicePool.instance;
    const releaseDevice = spyOn(pool, "releaseDevice");
    const context = createBareContext(device, true);
    const allocatorDestroy = jasmine
      .createSpy("uniformAllocator.destroy")
      .and.callFake(function () {
        throw firstCleanupError;
      });
    context._uniformAllocator = {
      destroy: allocatorDestroy,
    };
    const environmentTargetDestroy = jasmine
      .createSpy("environmentTargetPool.destroy")
      .and.callFake(function () {
        throw laterCleanupError;
      });
    context._environmentTargetPool = {
      destroy: environmentTargetDestroy,
    };

    expect(function () {
      context.destroy();
    }).toThrow(firstCleanupError);

    expect(allocatorDestroy).toHaveBeenCalledTimes(1);
    expect(environmentTargetDestroy).toHaveBeenCalledTimes(1);
    expect(releaseDevice).toHaveBeenCalledOnceWith(device);
    expect(device.destroy).not.toHaveBeenCalled();
    expect(context._uniformAllocator).toBeNull();
    expect(context._environmentTargetPool).toBeNull();
    expect(context._device).toBeNull();
    expect(context._deviceFromPool).toBeFalse();
    expect(context.isDestroyed()).toBeTrue();

    // Ownership was detached before external cleanup. A repeated destroy is
    // inert even though the first call reported its earliest cleanup error.
    expect(function () {
      context.destroy();
    }).not.toThrow();
    expect(releaseDevice).toHaveBeenCalledTimes(1);
  });

  it("publishes terminal state and drains mip ownership before early cleanup throws", function () {
    const earlyError = new Error("viewport cleanup failed");
    const device = {
      destroy: jasmine.createSpy("device.destroy"),
    };
    const pool = WebGPUDevicePool.instance;
    const releaseDevice = spyOn(pool, "releaseDevice");
    const context = createBareContext(device, true);
    context._pendingTextureMipJobs = [
      {
        texture: {},
        format: "rgba8unorm",
        mipLevelCount: 2,
        options: {
          dimension: "2d",
          baseArrayLayer: 0,
          arrayLayerCount: 1,
        },
        device,
        resourceGeneration: 0,
      },
    ];
    context._pendingTextureMipJobKeys = new WeakMap();
    context._viewportQuad = {
      destroy: jasmine.createSpy("viewport.destroy").and.throwError(earlyError),
    };

    expect(function () {
      context.destroy();
    }).toThrow(earlyError);

    expect(context.isDestroyed()).toBe(true);
    expect(context._pendingTextureMipJobs.length).toBe(0);
    expect(context._viewportQuad).toBeNull();
    expect(context.device).toBeNull();
    expect(releaseDevice).toHaveBeenCalledOnceWith(device);
  });

  it("continues isolated teardown after guarded cleanup throws", function () {
    const firstCleanupError = new Error("environment target cleanup failed");
    const device = {
      destroy: jasmine.createSpy("device.destroy"),
    };
    const pool = WebGPUDevicePool.instance;
    const releaseDevice = spyOn(pool, "releaseDevice");
    const context = createBareContext(device, false);
    const environmentTargetDestroy = jasmine
      .createSpy("environmentTargetPool.destroy")
      .and.callFake(function () {
        throw firstCleanupError;
      });
    context._environmentTargetPool = {
      destroy: environmentTargetDestroy,
    };

    expect(function () {
      context.destroy();
    }).toThrow(firstCleanupError);

    expect(environmentTargetDestroy).toHaveBeenCalledTimes(1);
    expect(releaseDevice).not.toHaveBeenCalled();
    expect(device.destroy).toHaveBeenCalledTimes(1);
    expect(context._environmentTargetPool).toBeNull();
    expect(context._device).toBeNull();
    expect(context._deviceFromPool).toBeFalse();
    expect(context.isDestroyed()).toBeTrue();

    expect(function () {
      context.destroy();
    }).not.toThrow();
    expect(device.destroy).toHaveBeenCalledTimes(1);
  });
});
