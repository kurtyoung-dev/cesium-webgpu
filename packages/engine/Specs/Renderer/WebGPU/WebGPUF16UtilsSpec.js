import WebGPUF16Utils from "../../../Source/Renderer/WebGPU/WebGPUF16Utils.js";

describe("Renderer/WebGPU/WebGPUF16Utils", function () {
  // WebGPUF16Utils is almost entirely pure: IEEE-754 half-precision
  // encode/decode, WGSL/vertex-layout codegen, and memory-savings math.
  // None of those paths touch a GPUDevice, so a Karma run gives us cheap
  // regression coverage that catches an accidental bit-twiddling or
  // format-map edit before it corrupts a half-precision vertex buffer.
  //
  // The single device-dependent path — `isSupported(device)` — is covered
  // with a hand-rolled stub (no real GPUDevice), exercising only the
  // `device.features.has("shader-f16")` delegation, never a live queue.

  describe("isSupported", function () {
    // Stub the minimal GPUDevice surface the method reads: a `features`
    // set with `.has()`. No real device, no async adapter request.
    it("returns true when the feature set contains 'shader-f16'", function () {
      const device = { features: new Set(["shader-f16"]) };
      expect(WebGPUF16Utils.isSupported(device)).toBe(true);
    });

    it("returns false when the feature set lacks 'shader-f16'", function () {
      const device = { features: new Set(["depth-clip-control"]) };
      expect(WebGPUF16Utils.isSupported(device)).toBe(false);
    });
  });

  describe("encodeF16", function () {
    // Spot-check the canonical encodings against the literal uint16 bit
    // patterns the IEEE-754 half-precision format defines. A reorder of
    // the sign/exponent/mantissa shifts would flip these.
    it("encodes +0 to 0x0000", function () {
      expect(WebGPUF16Utils.encodeF16(0)).toBe(0x0000);
    });

    it("encodes -0 to 0x8000 (sign bit only)", function () {
      expect(WebGPUF16Utils.encodeF16(-0)).toBe(0x8000);
    });

    it("encodes 1.0 to 0x3c00", function () {
      expect(WebGPUF16Utils.encodeF16(1.0)).toBe(0x3c00);
    });

    it("encodes -1.0 to 0xbc00 (sign + 1.0)", function () {
      expect(WebGPUF16Utils.encodeF16(-1.0)).toBe(0xbc00);
    });

    it("encodes 2.0 to 0x4000", function () {
      expect(WebGPUF16Utils.encodeF16(2.0)).toBe(0x4000);
    });

    it("encodes 0.5 to 0x3800", function () {
      // f32 0.5 = 0x3F000000: exp byte 126 → 126-127+15 = 14 → 14<<10.
      expect(WebGPUF16Utils.encodeF16(0.5)).toBe(0x3800);
    });

    it("encodes +Infinity to 0x7c00", function () {
      expect(WebGPUF16Utils.encodeF16(Infinity)).toBe(0x7c00);
    });

    it("encodes -Infinity to 0xfc00", function () {
      expect(WebGPUF16Utils.encodeF16(-Infinity)).toBe(0xfc00);
    });

    it("flushes a value too small for f16 to signed zero", function () {
      // 1e-30 underflows past the denormal range (exponent < -10) and is
      // flushed to +0 (sign bit clear).
      expect(WebGPUF16Utils.encodeF16(1e-30)).toBe(0x0000);
    });

    it("overflows a value too large for f16 to +Infinity", function () {
      // 1e30 exceeds the f16 max (65504) → exponent > 30 → 0x7c00.
      expect(WebGPUF16Utils.encodeF16(1e30)).toBe(0x7c00);
    });
  });

  describe("decodeF16", function () {
    it("decodes 0x0000 to +0", function () {
      const v = WebGPUF16Utils.decodeF16(0x0000);
      expect(v).toBe(0);
      // Distinguish +0 from -0: 1/(+0) === +Infinity.
      expect(1 / v).toBe(Infinity);
    });

    it("decodes 0x8000 to -0", function () {
      const v = WebGPUF16Utils.decodeF16(0x8000);
      expect(v).toBe(0);
      expect(1 / v).toBe(-Infinity);
    });

    it("decodes 0x3c00 to 1.0", function () {
      expect(WebGPUF16Utils.decodeF16(0x3c00)).toBe(1.0);
    });

    it("decodes 0xbc00 to -1.0", function () {
      expect(WebGPUF16Utils.decodeF16(0xbc00)).toBe(-1.0);
    });

    it("decodes 0x4000 to 2.0", function () {
      expect(WebGPUF16Utils.decodeF16(0x4000)).toBe(2.0);
    });

    it("decodes 0x3800 to 0.5", function () {
      expect(WebGPUF16Utils.decodeF16(0x3800)).toBe(0.5);
    });

    it("decodes 0x7c00 to +Infinity", function () {
      expect(WebGPUF16Utils.decodeF16(0x7c00)).toBe(Infinity);
    });

    it("decodes 0xfc00 to -Infinity", function () {
      expect(WebGPUF16Utils.decodeF16(0xfc00)).toBe(-Infinity);
    });

    it("decodes a non-zero exponent-31 pattern to NaN", function () {
      expect(WebGPUF16Utils.decodeF16(0x7e00)).toBeNaN();
    });
  });

  describe("encode/decode round-trip", function () {
    // f16 has ~10 bits of mantissa; values that are exactly representable
    // round-trip with zero error. These are all exact in half precision.
    it("round-trips exactly representable values", function () {
      const exact = [0, 1, -1, 2, -2, 0.5, -0.5, 0.25, 4, 8, -16, 1024];
      exact.forEach(function (value) {
        const decoded = WebGPUF16Utils.decodeF16(
          WebGPUF16Utils.encodeF16(value),
        );
        expect(decoded).toBe(value);
      });
    });

    it("round-trips a non-exact value within f16 precision", function () {
      // 0.1 is not exactly representable; tolerance is generous because
      // f16 has only ~3 decimal digits of precision.
      const decoded = WebGPUF16Utils.decodeF16(WebGPUF16Utils.encodeF16(0.1));
      expect(decoded).toBeCloseTo(0.1, 2);
    });
  });

  describe("encodeArrayF16", function () {
    it("returns a Uint16Array of the same length", function () {
      const input = new Float32Array([1.0, 2.0, 0.5, 0.0]);
      const out = WebGPUF16Utils.encodeArrayF16(input);
      expect(out).toBeInstanceOf(Uint16Array);
      expect(out.length).toBe(4);
    });

    it("encodes each element with encodeF16", function () {
      const input = new Float32Array([1.0, 2.0, 0.5, -1.0]);
      const out = WebGPUF16Utils.encodeArrayF16(input);
      expect(Array.from(out)).toEqual([0x3c00, 0x4000, 0x3800, 0xbc00]);
    });

    it("returns an empty array for empty input", function () {
      const out = WebGPUF16Utils.encodeArrayF16(new Float32Array([]));
      expect(out.length).toBe(0);
    });
  });

  describe("encodeNormalsF16 / encodeTexCoordsF16 / encodeColorsF16", function () {
    // These are thin aliases over encodeArrayF16; assert they delegate so
    // a future refactor that diverges them is caught.
    it("encodeNormalsF16 matches encodeArrayF16", function () {
      const input = new Float32Array([0.0, 1.0, -1.0]);
      expect(Array.from(WebGPUF16Utils.encodeNormalsF16(input))).toEqual(
        Array.from(WebGPUF16Utils.encodeArrayF16(input)),
      );
    });

    it("encodeTexCoordsF16 matches encodeArrayF16", function () {
      const input = new Float32Array([0.0, 0.5, 1.0, 0.25]);
      expect(Array.from(WebGPUF16Utils.encodeTexCoordsF16(input))).toEqual(
        Array.from(WebGPUF16Utils.encodeArrayF16(input)),
      );
    });

    it("encodeColorsF16 matches encodeArrayF16", function () {
      const input = new Float32Array([1.0, 0.5, 0.25, 1.0]);
      expect(Array.from(WebGPUF16Utils.encodeColorsF16(input))).toEqual(
        Array.from(WebGPUF16Utils.encodeArrayF16(input)),
      );
    });
  });

  describe("generateF16VertexInputWGSL", function () {
    it("always emits the `enable f16;` directive and struct wrapper", function () {
      const code = WebGPUF16Utils.generateF16VertexInputWGSL();
      expect(code).toContain("enable f16;");
      expect(code).toContain("struct F16VertexInput {");
      expect(code).toContain("};");
    });

    it("emits normals at the default start location (2) by default", function () {
      // Defaults: hasNormals=true, hasTexCoords=false, hasColors=false,
      // startLocation=2.
      const code = WebGPUF16Utils.generateF16VertexInputWGSL();
      expect(code).toContain("@location(2) normal: vec3<f16>,");
      expect(code).not.toContain("texCoord");
      expect(code).not.toContain("color");
    });

    it("assigns sequential locations across enabled attributes", function () {
      const code = WebGPUF16Utils.generateF16VertexInputWGSL(
        true,
        true,
        true,
        2,
      );
      expect(code).toContain("@location(2) normal: vec3<f16>,");
      expect(code).toContain("@location(3) texCoord: vec2<f16>,");
      expect(code).toContain("@location(4) color: vec4<f16>,");
    });

    it("skips disabled normals and reuses the start location", function () {
      const code = WebGPUF16Utils.generateF16VertexInputWGSL(
        false,
        true,
        false,
        5,
      );
      expect(code).not.toContain("normal");
      expect(code).toContain("@location(5) texCoord: vec2<f16>,");
    });

    it("honors a custom start location", function () {
      const code = WebGPUF16Utils.generateF16VertexInputWGSL(
        true,
        false,
        false,
        7,
      );
      expect(code).toContain("@location(7) normal: vec3<f16>,");
    });
  });

  describe("getF16VertexBufferLayout", function () {
    // Component count → WebGPU vertex format + stride. f16x1 and f16x3 do
    // not exist, so 1→x2 and 3→x4 with padding; stride is 4 bytes for
    // <=2 components and 8 bytes otherwise.
    it("maps 1 component to float16x2 with 4-byte stride", function () {
      const layout = WebGPUF16Utils.getF16VertexBufferLayout(1, 0);
      expect(layout.arrayStride).toBe(4);
      expect(layout.attributes[0].format).toBe("float16x2");
    });

    it("maps 2 components to float16x2 with 4-byte stride", function () {
      const layout = WebGPUF16Utils.getF16VertexBufferLayout(2, 1);
      expect(layout.arrayStride).toBe(4);
      expect(layout.attributes[0].format).toBe("float16x2");
    });

    it("maps 3 components to float16x4 with 8-byte stride", function () {
      const layout = WebGPUF16Utils.getF16VertexBufferLayout(3, 2);
      expect(layout.arrayStride).toBe(8);
      expect(layout.attributes[0].format).toBe("float16x4");
    });

    it("maps 4 components to float16x4 with 8-byte stride", function () {
      const layout = WebGPUF16Utils.getF16VertexBufferLayout(4, 3);
      expect(layout.arrayStride).toBe(8);
      expect(layout.attributes[0].format).toBe("float16x4");
    });

    it("falls back to float16x4 (8-byte stride) for an unmapped count", function () {
      // 5 is not in the format map → format defaults to float16x4 and the
      // `<=2 ? 4 : 8` stride rule yields 8.
      const layout = WebGPUF16Utils.getF16VertexBufferLayout(5, 0);
      expect(layout.attributes[0].format).toBe("float16x4");
      expect(layout.arrayStride).toBe(8);
    });

    it("threads the shaderLocation through and sets offset 0", function () {
      const layout = WebGPUF16Utils.getF16VertexBufferLayout(3, 9);
      expect(layout.attributes[0].shaderLocation).toBe(9);
      expect(layout.attributes[0].offset).toBe(0);
      expect(layout.attributes.length).toBe(1);
    });
  });

  describe("estimateMemorySavings", function () {
    // f32 = count*components*4, f16 = count*components*2, savings always 50%.
    it("computes f32/f16 byte sizes for normals (3 comp)", function () {
      const result = WebGPUF16Utils.estimateMemorySavings(1000, 3);
      expect(result.f32Bytes).toBe(12000);
      expect(result.f16Bytes).toBe(6000);
      expect(result.savingsBytes).toBe(6000);
      expect(result.savingsPercent).toBe(50);
    });

    it("computes byte sizes for texture coords (2 comp)", function () {
      const result = WebGPUF16Utils.estimateMemorySavings(500, 2);
      expect(result.f32Bytes).toBe(4000);
      expect(result.f16Bytes).toBe(2000);
      expect(result.savingsBytes).toBe(2000);
      expect(result.savingsPercent).toBe(50);
    });

    it("returns all-zero byte counts but still 50% for a zero vertex count", function () {
      const result = WebGPUF16Utils.estimateMemorySavings(0, 4);
      expect(result.f32Bytes).toBe(0);
      expect(result.f16Bytes).toBe(0);
      expect(result.savingsBytes).toBe(0);
      expect(result.savingsPercent).toBe(50);
    });
  });
});
