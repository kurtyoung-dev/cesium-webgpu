import {
  m4Values,
  gpuData,
  jsModule,
  numericArray,
} from "../../../Source/Renderer/WebGPU/webgpuTypeHelpers.js";

describe("Renderer/WebGPU/webgpuTypeHelpers", function () {
  // These helpers exist purely so that the WebGPU TS files can talk to
  // CesiumJS's untyped JS modules without spraying `as any` everywhere.
  // The implementations are intentionally trivial casts, so the spec
  // is mostly a contract test: it pins the JS-side runtime behaviour
  // (identity passthrough, no copies, no allocations) so that a future
  // refactor that accidentally adds copying or wrapping breaks loudly.

  describe("m4Values", function () {
    it("returns the same object reference for an array-like input", function () {
      const m = new Float64Array(16);
      m[12] = 7;
      const view = m4Values(m);
      // Identity check — must NOT clone.
      expect(view).toBe(m);
    });

    it("preserves numeric indexing through the cast", function () {
      const m = new Float64Array(16);
      m[12] = 1;
      m[13] = 2;
      m[14] = 3;
      const view = m4Values(m);
      expect(view[12]).toBe(1);
      expect(view[13]).toBe(2);
      expect(view[14]).toBe(3);
    });

    it("allows assignment through the cast", function () {
      const m = new Float64Array(16);
      const view = m4Values(m);
      view[15] = 42;
      // Mutation must hit the underlying buffer (not a copy).
      expect(m[15]).toBe(42);
    });

    it("works on plain arrays as well as typed arrays", function () {
      const arr = new Array(16).fill(0);
      const view = m4Values(arr);
      expect(view).toBe(arr);
      view[5] = 9;
      expect(arr[5]).toBe(9);
    });
  });

  describe("gpuData", function () {
    // gpuData is a no-op cast that exists only because TS 5.x narrowed
    // typed arrays to a generic that doesn't satisfy
    // GPUAllowSharedBufferSource. Spec it as identity so a future
    // refactor that "helps" by wrapping the buffer fails immediately.
    it("returns the input Float32Array unchanged", function () {
      const data = new Float32Array([1, 2, 3, 4]);
      const result = gpuData(data);
      expect(result).toBe(data);
    });

    it("returns the input Uint8Array unchanged", function () {
      const data = new Uint8Array([0, 255, 128, 64]);
      const result = gpuData(data);
      expect(result).toBe(data);
    });

    it("returns a raw ArrayBuffer unchanged", function () {
      const buffer = new ArrayBuffer(64);
      const result = gpuData(buffer);
      expect(result).toBe(buffer);
    });
  });

  describe("jsModule", function () {
    // jsModule is the typed-cast helper that lets WebGPU TS code call
    // static methods on JS-only Cesium modules (IndexDatatype,
    // EncodedCartesian3, RenderState, ContextLimits) without an
    // `as any`. The runtime behaviour is identity — the test pins
    // that contract.
    it("returns the input module reference unchanged", function () {
      const fakeModule = {
        createTypedArray: function (a, b) {
          return [a, b];
        },
      };
      const typed = jsModule(fakeModule);
      expect(typed).toBe(fakeModule);
    });

    it("preserves callable methods through the cast", function () {
      const fakeModule = {
        encode: function (value, result) {
          result.high = value | 0;
          result.low = value - (value | 0);
        },
      };
      const typed = jsModule(fakeModule);
      const out = { high: 0, low: 0 };
      typed.encode(3.5, out);
      expect(out.high).toBe(3);
      expect(out.low).toBeCloseTo(0.5, 5);
    });
  });

  describe("numericArray", function () {
    // numericArray covers the Cartesian3.fromArray(typedArray, ...)
    // pattern: a number[] declared API that accepts any indexable
    // numeric source. The cast must be a true identity — never a copy.
    it("returns a Float32Array unchanged", function () {
      const data = new Float32Array([1, 2, 3, 4, 5, 6]);
      const result = numericArray(data);
      expect(result).toBe(data);
      expect(result[3]).toBe(4);
    });

    it("returns a Float64Array unchanged", function () {
      const data = new Float64Array([0.5, 1.5, 2.5]);
      const result = numericArray(data);
      expect(result).toBe(data);
    });

    it("returns a plain number[] unchanged", function () {
      const data = [10, 20, 30];
      const result = numericArray(data);
      expect(result).toBe(data);
    });

    it("preserves length through the cast", function () {
      const data = new Float32Array(12);
      const result = numericArray(data);
      expect(result.length).toBe(12);
    });
  });
});
