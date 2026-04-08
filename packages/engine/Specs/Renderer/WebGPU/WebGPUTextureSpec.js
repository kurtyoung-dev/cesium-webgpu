import WebGPUTexture from "../../../Source/Renderer/WebGPU/WebGPUTexture.js";

describe("Renderer/WebGPU/WebGPUTexture", function () {
  let device;
  const hasWebGPU =
    typeof navigator !== "undefined" && typeof navigator.gpu !== "undefined";

  if (hasWebGPU) {
    beforeAll(async function () {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          device = await adapter.requestDevice();
        }
      } catch (e) {
        // WebGPU not available
      }
    });

    afterAll(function () {
      if (device) {
        device.destroy();
        device = undefined;
      }
    });
  }

  it("is defined", function () {
    expect(WebGPUTexture).toBeDefined();
  });

  it("has static factory methods", function () {
    expect(typeof WebGPUTexture.create2D).toBe("function");
    expect(typeof WebGPUTexture.createCubeMap).toBe("function");
  });

  it("has static utility methods", function () {
    expect(typeof WebGPUTexture.getBytesPerPixel).toBe("function");
    expect(typeof WebGPUTexture.flipYData).toBe("function");
    expect(typeof WebGPUTexture.premultiplyAlpha).toBe("function");
  });

  describe("static utilities", function () {
    it("reports bytes per pixel for common formats", function () {
      expect(WebGPUTexture.getBytesPerPixel("rgba8unorm")).toEqual(4);
      expect(WebGPUTexture.getBytesPerPixel("bgra8unorm")).toEqual(4);
      expect(WebGPUTexture.getBytesPerPixel("r8unorm")).toEqual(1);
      expect(WebGPUTexture.getBytesPerPixel("rg8unorm")).toEqual(2);
    });

    it("flips Y axis of pixel data", function () {
      // 2x2 RGBA image
      const data = new Uint8Array([
        255,
        0,
        0,
        255, // top-left: red
        0,
        255,
        0,
        255, // top-right: green
        0,
        0,
        255,
        255, // bottom-left: blue
        255,
        255,
        0,
        255, // bottom-right: yellow
      ]);

      const flipped = WebGPUTexture.flipYData(data, 2, 2, 4);

      // After flip: bottom row should be first
      expect(flipped[0]).toEqual(0); // was bottom-left blue
      expect(flipped[1]).toEqual(0);
      expect(flipped[2]).toEqual(255);
      expect(flipped[8]).toEqual(255); // was top-left red
      expect(flipped[9]).toEqual(0);
      expect(flipped[10]).toEqual(0);
    });

    it("premultiplies alpha", function () {
      // Semi-transparent red pixel
      const data = new Uint8Array([255, 0, 0, 128]);
      const result = WebGPUTexture.premultiplyAlpha(data);

      // RGB should be multiplied by alpha/255
      expect(result[0]).toBeLessThan(255); // red * 128/255
      expect(result[1]).toEqual(0);
      expect(result[2]).toEqual(0);
      expect(result[3]).toEqual(128); // alpha unchanged
    });
  });

  describe("with GPU device", function () {
    beforeEach(function () {
      if (!device) {
        pending("WebGPU device not available");
      }
    });

    it("creates a 2D texture", function () {
      const texture = WebGPUTexture.create2D(
        device,
        256,
        256,
        "rgba8unorm",
        1,
        "test-2d",
      );

      expect(texture).toBeDefined();
      expect(texture.width).toEqual(256);
      expect(texture.height).toEqual(256);
      expect(texture.format).toEqual("rgba8unorm");
      expect(texture.texture).toBeDefined();
      expect(texture.view).toBeDefined();
      expect(texture.sampler).toBeDefined();
      expect(texture.isDestroyed).toBe(false);
      expect(texture.isCubeMap).toBe(false);

      texture.destroy();
      expect(texture.isDestroyed).toBe(true);
    });

    it("creates a cubemap texture", function () {
      const texture = WebGPUTexture.createCubeMap(
        device,
        64,
        "rgba8unorm",
        1,
        "test-cube",
      );

      expect(texture).toBeDefined();
      expect(texture.width).toEqual(64);
      expect(texture.height).toEqual(64);
      expect(texture.depth).toEqual(6);
      expect(texture.isCubeMap).toBe(true);

      texture.destroy();
    });

    it("writes pixel data to a 2D texture", function () {
      const texture = WebGPUTexture.create2D(
        device,
        4,
        4,
        "rgba8unorm",
        1,
        "test-write",
      );

      const pixelData = new Uint8Array(4 * 4 * 4); // 4x4 RGBA
      for (let i = 0; i < pixelData.length; i += 4) {
        pixelData[i] = 255; // R
        pixelData[i + 1] = 0; // G
        pixelData[i + 2] = 0; // B
        pixelData[i + 3] = 255; // A
      }

      // Should not throw
      texture.write(pixelData, 4, 4);

      texture.destroy();
    });

    it("creates a view for a 2D texture", function () {
      const texture = WebGPUTexture.create2D(
        device,
        32,
        32,
        "rgba8unorm",
        1,
        "test-view",
      );

      const view = texture.view;
      expect(view).toBeDefined();

      // Custom view
      const customView = texture.createView({
        format: "rgba8unorm",
        dimension: "2d",
        baseMipLevel: 0,
        mipLevelCount: 1,
      });
      expect(customView).toBeDefined();

      texture.destroy();
    });

    it("creates a texture with multiple mip levels", function () {
      const texture = WebGPUTexture.create2D(
        device,
        256,
        256,
        "rgba8unorm",
        5,
        "test-mips",
      );

      expect(texture.mipLevelCount).toEqual(5);

      texture.destroy();
    });
  });
});
