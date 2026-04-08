import WebGPUSubgroupUtils from "../../../Source/Renderer/WebGPU/WebGPUSubgroupUtils.js";

describe("Renderer/WebGPU/WebGPUSubgroupUtils", function () {
  let device;
  let adapter;
  const hasWebGPU =
    typeof navigator !== "undefined" && typeof navigator.gpu !== "undefined";

  if (hasWebGPU) {
    beforeAll(async function () {
      try {
        adapter = await navigator.gpu.requestAdapter();
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
    expect(typeof WebGPUSubgroupUtils.isSupported).toBe("function");
    expect(typeof WebGPUSubgroupUtils.getInfo).toBe("function");
    expect(typeof WebGPUSubgroupUtils.generateReductionWGSL).toBe("function");
    expect(typeof WebGPUSubgroupUtils.generatePrefixSumWGSL).toBe("function");
    expect(typeof WebGPUSubgroupUtils.generateBallotWGSL).toBe("function");
    expect(typeof WebGPUSubgroupUtils.generateWorkgroupReductionWGSL).toBe(
      "function",
    );
    expect(typeof WebGPUSubgroupUtils.getRequiredFeatures).toBe("function");
  });

  describe("getRequiredFeatures", function () {
    it("includes the subgroups feature name", function () {
      const features = WebGPUSubgroupUtils.getRequiredFeatures();
      expect(Array.isArray(features)).toBe(true);
      expect(features).toContain("subgroups");
    });
  });

  describe("generateReductionWGSL", function () {
    it("defaults to add/f32 and emits enable subgroups", function () {
      const wgsl = WebGPUSubgroupUtils.generateReductionWGSL();
      expect(wgsl).toContain("enable subgroups");
      expect(wgsl).toContain("subgroupAdd");
      expect(wgsl).toContain("f32");
      expect(wgsl).toContain("subgroupReduce_add");
    });

    it("threads the operation and value type through", function () {
      const wgsl = WebGPUSubgroupUtils.generateReductionWGSL("min", "u32");
      expect(wgsl).toContain("subgroupMin");
      expect(wgsl).toContain("u32");
      expect(wgsl).toContain("subgroupReduce_min");
      expect(wgsl).not.toContain("subgroupAdd");
    });

    it("supports max reductions", function () {
      const wgsl = WebGPUSubgroupUtils.generateReductionWGSL("max", "i32");
      expect(wgsl).toContain("subgroupMax");
      expect(wgsl).toContain("i32");
    });
  });

  describe("generatePrefixSumWGSL", function () {
    it("emits both exclusive and inclusive variants", function () {
      const wgsl = WebGPUSubgroupUtils.generatePrefixSumWGSL();
      expect(wgsl).toContain("subgroupPrefixSum");
      expect(wgsl).toContain("subgroupInclusivePrefixSum");
      expect(wgsl).toContain("subgroupExclusiveAdd");
    });

    it("respects the value type parameter", function () {
      const wgsl = WebGPUSubgroupUtils.generatePrefixSumWGSL("f32");
      expect(wgsl).toContain("f32");
    });
  });

  describe("generateBallotWGSL", function () {
    it("emits ballot + countOneBits and broadcast helpers", function () {
      const wgsl = WebGPUSubgroupUtils.generateBallotWGSL();
      expect(wgsl).toContain("subgroupBallot");
      expect(wgsl).toContain("countOneBits");
      expect(wgsl).toContain("subgroupBroadcast");
    });
  });

  describe("generateWorkgroupReductionWGSL", function () {
    it("sizes the shared-memory array to ceil(workgroupSize / subgroupSize)", function () {
      const wgsl = WebGPUSubgroupUtils.generateWorkgroupReductionWGSL(256, 32);
      // 256 / 32 = 8 — array length must match.
      expect(wgsl).toContain("array<f32, 8>");
      expect(wgsl).toContain("workgroupBarrier");
    });

    it("rounds up partial workgroups", function () {
      const wgsl = WebGPUSubgroupUtils.generateWorkgroupReductionWGSL(100, 32);
      // ceil(100/32) = 4
      expect(wgsl).toContain("array<f32, 4>");
    });
  });

  describe("with GPU device", function () {
    beforeEach(function () {
      if (!device) {
        pending("WebGPU device not available");
      }
    });

    it("isSupported reflects device.features.has('subgroups')", function () {
      const expected = device.features.has("subgroups");
      expect(WebGPUSubgroupUtils.isSupported(device)).toBe(expected);
    });

    it("getInfo populates description and subgroupSize", function () {
      const info = WebGPUSubgroupUtils.getInfo(device, adapter);
      expect(info).toBeDefined();
      expect(typeof info.supported).toBe("boolean");
      expect(typeof info.subgroupSize).toBe("number");
      expect(info.subgroupSize).toBeGreaterThan(0);
      expect(typeof info.description).toBe("string");
    });
  });
});
