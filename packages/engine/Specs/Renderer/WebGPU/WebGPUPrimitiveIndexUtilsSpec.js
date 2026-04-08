import WebGPUPrimitiveIndexUtils from "../../../Source/Renderer/WebGPU/WebGPUPrimitiveIndexUtils.js";

describe("Renderer/WebGPU/WebGPUPrimitiveIndexUtils", function () {
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

  it("is defined with the expected static surface", function () {
    expect(WebGPUPrimitiveIndexUtils).toBeDefined();
    expect(typeof WebGPUPrimitiveIndexUtils.isSupported).toBe("function");
    expect(typeof WebGPUPrimitiveIndexUtils.generateFaceColorWGSL).toBe(
      "function",
    );
    expect(typeof WebGPUPrimitiveIndexUtils.generatePrimitivePickWGSL).toBe(
      "function",
    );
    expect(typeof WebGPUPrimitiveIndexUtils.decodePrimitivePick).toBe(
      "function",
    );
  });

  describe("generateFaceColorWGSL", function () {
    it("emits a fragment entry point with primitive_index input", function () {
      const wgsl = WebGPUPrimitiveIndexUtils.generateFaceColorWGSL();
      expect(wgsl).toContain("@fragment");
      expect(wgsl).toContain("@builtin(primitive_index)");
      expect(wgsl).toContain("fn fragmentMain");
      expect(wgsl).toContain("@location(0) vec4<f32>");
    });

    it("returns deterministic output", function () {
      const a = WebGPUPrimitiveIndexUtils.generateFaceColorWGSL();
      const b = WebGPUPrimitiveIndexUtils.generateFaceColorWGSL();
      expect(a).toEqual(b);
    });
  });

  describe("generatePrimitivePickWGSL", function () {
    it("packs the index across all four channels", function () {
      const wgsl = WebGPUPrimitiveIndexUtils.generatePrimitivePickWGSL();
      // Each byte of the u32 must be extracted into one channel.
      expect(wgsl).toContain(">>  0u");
      expect(wgsl).toContain(">>  8u");
      expect(wgsl).toContain(">> 16u");
      expect(wgsl).toContain(">> 24u");
    });
  });

  describe("decodePrimitivePick", function () {
    it("round-trips small indices encoded LSB-first", function () {
      // Manually emulate the WGSL encoder for index 1234.
      const idx = 1234;
      const rgba = new Uint8Array([
        idx & 0xff,
        (idx >>> 8) & 0xff,
        (idx >>> 16) & 0xff,
        (idx >>> 24) & 0xff,
      ]);
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba)).toBe(idx);
    });

    it("round-trips a 24-bit index", function () {
      const idx = 0xabcdef;
      const rgba = new Uint8Array([0xef, 0xcd, 0xab, 0x00]);
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba)).toBe(idx);
    });

    it("respects the offset parameter", function () {
      const padding = [0, 0, 0, 0, 0];
      const payload = [0x10, 0x20, 0x30, 0x40];
      const rgba = new Uint8Array([...padding, ...payload]);
      // Decoded value: 0x40302010
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba, 5)).toBe(
        0x40302010 | 0,
      );
    });

    it("handles index 0", function () {
      const rgba = new Uint8Array([0, 0, 0, 0]);
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba)).toBe(0);
    });
  });

  describe("with GPU device", function () {
    beforeEach(function () {
      if (!device) {
        pending("WebGPU device not available");
      }
    });

    it("isSupported returns a boolean and caches the result", function () {
      const first = WebGPUPrimitiveIndexUtils.isSupported(device);
      const second = WebGPUPrimitiveIndexUtils.isSupported(device);
      expect(typeof first).toBe("boolean");
      expect(first).toBe(second);
    });
  });
});
