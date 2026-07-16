import GraphicsContext from "../../../Source/Renderer/GraphicsContext.js";
import { WebGPUContext } from "../../../Source/Renderer/WebGPU/WebGPUContext.js";
import { WebGPUDevicePool } from "../../../Source/Renderer/WebGPU/WebGPUDevicePool.js";

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
});
