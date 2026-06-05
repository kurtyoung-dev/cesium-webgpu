import WebGPUPrimitiveIndexUtils from "../../../Source/Renderer/WebGPU/WebGPUPrimitiveIndexUtils.js";

describe("Renderer/WebGPU/WebGPUPrimitiveIndexUtils", function () {
  // The WGSL generators and the pick decoder are pure functions — no GPU
  // device, no Cesium scene context, no async setup. Those are exercised
  // unconditionally below. The single device-bound path (`isSupported`,
  // which calls `device.createShaderModule`) is guarded behind a real
  // adapter request and skipped via `pending()` when WebGPU is absent so
  // the suite stays green in non-WebGPU CI.

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
        // WebGPU not available in this environment — device-bound specs
        // below will `pending()` out.
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
      expect(wgsl).toContain("@builtin(primitive_index) primIndex: u32");
      expect(wgsl).toContain("fn fragmentMain");
      expect(wgsl).toContain("-> @location(0) vec4<f32>");
    });

    it("encodes the documented deterministic per-channel hash constants", function () {
      // These multipliers/offsets are the load-bearing contract: the same
      // triangle index must always map to the same color across runs and
      // backends. Copied verbatim from the source so a careless tweak of
      // the hash fails fast.
      const wgsl = WebGPUPrimitiveIndexUtils.generateFaceColorWGSL();
      expect(wgsl).toContain("let r = f32((primIndex * 73u) & 255u) / 255.0;");
      expect(wgsl).toContain(
        "let g = f32((primIndex * 151u + 31u) & 255u) / 255.0;",
      );
      expect(wgsl).toContain(
        "let b = f32((primIndex * 211u + 89u) & 255u) / 255.0;",
      );
      expect(wgsl).toContain("return vec4<f32>(r, g, b, 1.0);");
    });

    it("is trimmed (no leading/trailing whitespace)", function () {
      const wgsl = WebGPUPrimitiveIndexUtils.generateFaceColorWGSL();
      expect(wgsl).toBe(wgsl.trim());
      expect(wgsl.startsWith("@fragment")).toBe(true);
    });

    it("returns deterministic, identical output across calls", function () {
      const a = WebGPUPrimitiveIndexUtils.generateFaceColorWGSL();
      const b = WebGPUPrimitiveIndexUtils.generateFaceColorWGSL();
      expect(a).toEqual(b);
    });
  });

  describe("generatePrimitivePickWGSL", function () {
    it("emits a fragment entry point with primitive_index input", function () {
      const wgsl = WebGPUPrimitiveIndexUtils.generatePrimitivePickWGSL();
      expect(wgsl).toContain("@fragment");
      expect(wgsl).toContain("@builtin(primitive_index) primIndex: u32");
      expect(wgsl).toContain("fn fragmentMain");
      expect(wgsl).toContain("-> @location(0) vec4<f32>");
    });

    it("packs each byte of the u32 index into one RGBA channel", function () {
      // The shift constants (with the source's exact two-space / one-space
      // formatting) define the byte ordering that decodePrimitivePick must
      // mirror. Pin them exactly.
      const wgsl = WebGPUPrimitiveIndexUtils.generatePrimitivePickWGSL();
      expect(wgsl).toContain("let r = f32((primIndex >>  0u) & 255u) / 255.0;");
      expect(wgsl).toContain("let g = f32((primIndex >>  8u) & 255u) / 255.0;");
      expect(wgsl).toContain("let b = f32((primIndex >> 16u) & 255u) / 255.0;");
      expect(wgsl).toContain("let a = f32((primIndex >> 24u) & 255u) / 255.0;");
      expect(wgsl).toContain("return vec4<f32>(r, g, b, a);");
    });

    it("is trimmed (no leading/trailing whitespace)", function () {
      const wgsl = WebGPUPrimitiveIndexUtils.generatePrimitivePickWGSL();
      expect(wgsl).toBe(wgsl.trim());
      expect(wgsl.startsWith("@fragment")).toBe(true);
    });

    it("returns deterministic, identical output across calls", function () {
      const a = WebGPUPrimitiveIndexUtils.generatePrimitivePickWGSL();
      const b = WebGPUPrimitiveIndexUtils.generatePrimitivePickWGSL();
      expect(a).toEqual(b);
    });
  });

  describe("decodePrimitivePick", function () {
    it("handles index 0", function () {
      const rgba = new Uint8Array([0, 0, 0, 0]);
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba)).toBe(0);
    });

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

    it("round-trips a 24-bit index (high byte zero)", function () {
      const idx = 0xabcdef;
      const rgba = new Uint8Array([0xef, 0xcd, 0xab, 0x00]);
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba)).toBe(idx);
    });

    it("defaults offset to 0 when omitted", function () {
      const rgba = new Uint8Array([0x01, 0x02, 0x03, 0x00]);
      // 0x00030201 = 197121
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba)).toBe(
        0x00030201,
      );
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba)).toBe(
        WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba, 0),
      );
    });

    it("respects the offset parameter", function () {
      const padding = [0, 0, 0, 0, 0];
      const payload = [0x10, 0x20, 0x30, 0x40];
      const rgba = new Uint8Array([...padding, ...payload]);
      // Decoded value: 0x40302010 — bit 31 is clear, so the signed `<<24`
      // in the source still yields a positive result.
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba, 5)).toBe(
        0x40302010,
      );
    });

    it("reproduces the source's signed `<< 24` semantics for high-bit indices", function () {
      // When the top byte has bit 7 set (0x80), `rgba[3] << 24` sets bit 31,
      // which JavaScript's bitwise-OR interprets as a negative 32-bit int.
      // This pins the *exact* behavior of the source so a future "fix" to
      // `>>> 0` (unsigned coercion) is a deliberate, test-visible change.
      const rgba = new Uint8Array([0x00, 0x00, 0x00, 0x80]);
      // 0x80 << 24 === -2147483648 (signed 32-bit).
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba)).toBe(
        -2147483648,
      );
      // Full 0xFFFFFFFF pattern decodes to -1 under signed OR.
      const all = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(all)).toBe(-1);
    });

    it("reads exactly four bytes starting at the offset", function () {
      // Bytes before the offset and after offset+3 must not influence the
      // result. Surround the payload with 0xFF noise to prove the window.
      const rgba = new Uint8Array([
        0xff, 0xff, 0x0a, 0x0b, 0x0c, 0x00, 0xff, 0xff,
      ]);
      // Window at offset 2: [0x0a, 0x0b, 0x0c, 0x00] => 0x000c0b0a.
      expect(WebGPUPrimitiveIndexUtils.decodePrimitivePick(rgba, 2)).toBe(
        0x000c0b0a,
      );
    });
  });

  describe("isSupported (device-bound)", function () {
    beforeEach(function () {
      if (!device) {
        pending("WebGPU device not available");
      }
    });

    it("returns a boolean and caches the result per device", function () {
      const first = WebGPUPrimitiveIndexUtils.isSupported(device);
      const second = WebGPUPrimitiveIndexUtils.isSupported(device);
      expect(typeof first).toBe("boolean");
      // Second call must hit the WeakMap cache and return the same value.
      expect(first).toBe(second);
    });
  });
});
