import WebGPUImageUpload from "../../../Source/Renderer/WebGPU/WebGPUImageUpload.js";

describe("Renderer/WebGPU/WebGPUImageUpload", function () {
  let device;
  const hasWebGPU =
    typeof navigator !== "undefined" && typeof navigator.gpu !== "undefined";
  const hasCanvas = typeof document !== "undefined";

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

  it("exposes the expected static surface", function () {
    expect(WebGPUImageUpload).toBeDefined();
    expect(typeof WebGPUImageUpload.decodeWithOrientation).toBe("function");
    expect(typeof WebGPUImageUpload.uploadImageToTexture).toBe("function");
    expect(typeof WebGPUImageUpload.isOrientationSupported).toBe("function");
  });

  describe("decodeWithOrientation", function () {
    it("passes through an HTMLCanvasElement unchanged", async function () {
      if (!hasCanvas) {
        pending("document not available in this environment");
      }
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 4;
      const result = await WebGPUImageUpload.decodeWithOrientation(canvas);
      expect(result).toBe(canvas);
    });

    it("passes through an OffscreenCanvas unchanged", async function () {
      if (typeof OffscreenCanvas === "undefined") {
        pending("OffscreenCanvas not available");
      }
      const off = new OffscreenCanvas(8, 8);
      const result = await WebGPUImageUpload.decodeWithOrientation(off);
      expect(result).toBe(off);
    });

    it("decodes a Blob via createImageBitmap", async function () {
      if (typeof createImageBitmap === "undefined") {
        pending("createImageBitmap not available");
      }
      // Smallest valid PNG: 1x1 transparent.
      const onePixel = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      const blob = new Blob([onePixel], { type: "image/png" });
      const decoded = await WebGPUImageUpload.decodeWithOrientation(blob);
      expect(decoded).toBeDefined();
      expect(decoded.width).toBe(1);
      expect(decoded.height).toBe(1);
      // ImageBitmap exposes a close() method.
      if (decoded.close) {
        decoded.close();
      }
    });

    it("passes through an existing ImageBitmap unchanged", async function () {
      if (typeof createImageBitmap === "undefined" || !hasCanvas) {
        pending("createImageBitmap not available");
      }
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      const bmp = await createImageBitmap(canvas);
      const result = await WebGPUImageUpload.decodeWithOrientation(bmp);
      expect(result).toBe(bmp);
      bmp.close?.();
    });
  });

  describe("isOrientationSupported", function () {
    it("returns a boolean and caches the result", async function () {
      if (typeof createImageBitmap === "undefined") {
        pending("createImageBitmap not available");
      }
      const first = await WebGPUImageUpload.isOrientationSupported();
      const second = await WebGPUImageUpload.isOrientationSupported();
      expect(typeof first).toBe("boolean");
      expect(first).toBe(second);
    });
  });

  describe("with GPU device", function () {
    beforeEach(function () {
      if (!device) {
        pending("WebGPU device not available");
      }
      if (!hasCanvas) {
        pending("document not available");
      }
    });

    it("uploads a canvas source into a texture without throwing", async function () {
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 4;
      const ctx2d = canvas.getContext("2d");
      ctx2d.fillStyle = "red";
      ctx2d.fillRect(0, 0, 4, 4);

      const texture = device.createTexture({
        size: { width: 4, height: 4 },
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      const dims = await WebGPUImageUpload.uploadImageToTexture(
        device,
        canvas,
        texture,
        { respectEXIF: false },
      );
      expect(dims.width).toBe(4);
      expect(dims.height).toBe(4);
      texture.destroy();
    });
  });
});
