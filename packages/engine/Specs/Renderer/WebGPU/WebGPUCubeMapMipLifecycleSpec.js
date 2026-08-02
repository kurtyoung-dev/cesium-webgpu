import WebGPUCubeMap from "../../../Source/Renderer/WebGPU/WebGPUCubeMap.js";

describe("Renderer/WebGPU/WebGPUCubeMap mip lifecycle", function () {
  it("reserves full-chain residency, honors queue rejection, and cancels before destroy", function () {
    const events = [];
    const native = {
      destroy: function () {
        events.push("destroy");
      },
    };
    let descriptor;
    const device = {
      features: new Set(["core-features-and-limits"]),
      createTexture: function (value) {
        descriptor = value;
        return native;
      },
    };
    const context = {
      _device: device,
      enqueueTextureMipGeneration: jasmine
        .createSpy("enqueueTextureMipGeneration")
        .and.returnValue(false),
      cancelTextureMipGeneration: function (texture) {
        expect(texture).toBe(native);
        events.push("cancel");
        throw new Error("synthetic cancellation failure");
      },
    };
    const cube = new WebGPUCubeMap({ context: context, width: 4, height: 4 });

    expect(descriptor.textureBindingViewDimension).toBe("cube");
    expect(descriptor.mipLevelCount).toBe(3);
    // (4² + 2² + 1²) texels × 6 faces × 4 RGBA8 bytes.
    expect(cube.sizeInBytes).toBe(504);
    cube.generateMipmap();
    expect(context.enqueueTextureMipGeneration).toHaveBeenCalledOnceWith(
      native,
      "rgba8unorm",
      3,
      {
        dimension: "cube",
        baseArrayLayer: 0,
        arrayLayerCount: 6,
      },
    );

    cube.destroy();
    expect(events).toEqual(["cancel", "destroy"]);
    expect(cube.isDestroyed()).toBe(true);
  });

  it("retains render-attachment usage for mapped depth cube targets", function () {
    const descriptors = [];
    const device = {
      features: new Set(),
      createTexture: function (descriptor) {
        descriptors.push(descriptor);
        return { destroy: function () {} };
      },
    };
    const context = { _device: device };
    const cases = [
      [0x1403, "depth16unorm"], // UNSIGNED_SHORT
      [0x1401, "depth24plus"], // fallback depth representation
      [0x1405, "depth32float"], // UNSIGNED_INT mapping
    ];
    for (const [pixelDatatype, expectedFormat] of cases) {
      const cube = new WebGPUCubeMap({
        context,
        width: 4,
        height: 4,
        pixelFormat: 0x1902, // DEPTH_COMPONENT
        pixelDatatype,
      });
      const descriptor = descriptors[descriptors.length - 1];
      expect(descriptor.format).toBe(expectedFormat);
      expect(descriptor.usage & GPUTextureUsage.RENDER_ATTACHMENT).not.toBe(0);
      expect(descriptor.textureBindingViewDimension).toBe("cube");
      cube.destroy();
    }
  });

  it("keeps unsupported generated-mip formats valid at one level", function () {
    let descriptor;
    const native = { destroy: function () {} };
    const context = {
      _device: {
        features: new Set(),
        createTexture: function (value) {
          descriptor = value;
          return native;
        },
      },
      enqueueTextureMipGeneration: jasmine.createSpy(
        "enqueueTextureMipGeneration",
      ),
    };
    const cube = new WebGPUCubeMap({
      context,
      width: 4,
      height: 4,
      pixelDatatype: 0x1406, // FLOAT -> rgba32float
    });

    expect(descriptor.format).toBe("rgba32float");
    expect(descriptor.mipLevelCount).toBe(1);
    expect(descriptor.usage & GPUTextureUsage.TEXTURE_BINDING).not.toBe(0);
    expect(descriptor.usage & GPUTextureUsage.COPY_DST).not.toBe(0);
    // rgba32float is color-renderable even when it is not filterable; retain
    // cubemap render-target functionality while declining auto-generation.
    expect(descriptor.usage & GPUTextureUsage.RENDER_ATTACHMENT).not.toBe(0);
    expect(cube.sizeInBytes).toBe(4 * 4 * 6 * 16);
    cube.generateMipmap();
    expect(context.enqueueTextureMipGeneration).not.toHaveBeenCalled();
    cube.destroy();
  });

  it("detaches logical cube ownership when native destruction throws", function () {
    const nativeError = new Error("synthetic cube destroy failure");
    const native = {
      destroy: jasmine.createSpy("destroy").and.throwError(nativeError),
    };
    const context = {
      _device: {
        features: new Set(),
        createTexture: function () {
          return native;
        },
      },
      cancelTextureMipGeneration: jasmine.createSpy(
        "cancelTextureMipGeneration",
      ),
    };
    const cube = new WebGPUCubeMap({ context, width: 1, height: 1 });

    expect(function () {
      cube.destroy();
    }).toThrow(nativeError);
    expect(cube.isDestroyed()).toBe(true);
    expect(cube.gpuTexture).toBeNull();

    cube.destroy();
    expect(native.destroy).toHaveBeenCalledTimes(1);
    expect(context.cancelTextureMipGeneration).toHaveBeenCalledTimes(1);
  });

  it("uses one valid level on compatibility adapters without core layer views", function () {
    let descriptor;
    const native = { destroy: function () {} };
    const context = {
      featureLevel: "compatibility",
      _device: {
        features: new Set(),
        createTexture: function (value) {
          descriptor = value;
          return native;
        },
      },
      enqueueTextureMipGeneration: jasmine.createSpy(
        "enqueueTextureMipGeneration",
      ),
    };
    const cube = new WebGPUCubeMap({ context, width: 4, height: 4 });

    expect(descriptor.mipLevelCount).toBe(1);
    cube.generateMipmap();
    expect(context.enqueueTextureMipGeneration).not.toHaveBeenCalled();
    cube.destroy();
  });
});
