import {
  MRT_NORMAL_ROUGHNESS_FORMAT,
  setSceneFBMrtMode,
  isSceneFBMrtMode,
  makeSceneFBTargets,
  makeSceneFBTargetsMRT,
} from "../../../Source/Renderer/WebGPU/WebGPUSceneFBTargetHelpers.js";

// Pure-function specs — no GPU device needed. The helper builds plain
// JS object arrays (GPUColorTargetState descriptors) from a format
// string + options bag, plus a module-scoped MRT-mode flag. Every
// assertion below exercises that pure object-shape logic; nothing here
// touches a GPUDevice, queue, or pipeline.
//
// The MRT-mode flag is module-scoped, so each block that depends on a
// specific mode sets it explicitly. An afterEach restores it to the
// source default (true — see the SUB-C DEBUG flip note in the module)
// so spec ordering can't leak state into unrelated suites.

describe("Renderer/WebGPU/WebGPUSceneFBTargetHelpers", function () {
  // Capture the module's initial default before any test mutates it.
  const SOURCE_DEFAULT_MRT_MODE = isSceneFBMrtMode();

  afterEach(function () {
    setSceneFBMrtMode(SOURCE_DEFAULT_MRT_MODE);
  });

  describe("MRT_NORMAL_ROUGHNESS_FORMAT", function () {
    it("is the rgba16float G-buffer format", function () {
      expect(MRT_NORMAL_ROUGHNESS_FORMAT).toBe("rgba16float");
    });
  });

  describe("setSceneFBMrtMode / isSceneFBMrtMode", function () {
    it("defaults to true as written in the source (SUB-C DEBUG flip)", function () {
      // The module ships with `_mrtMode = true` (the Slice 5c-B SUB-C
      // investigation flip). This guards against an accidental revert
      // to false without the matching globe 2-target wiring.
      expect(SOURCE_DEFAULT_MRT_MODE).toBe(true);
    });

    it("reflects the value set by setSceneFBMrtMode", function () {
      setSceneFBMrtMode(false);
      expect(isSceneFBMrtMode()).toBe(false);
      setSceneFBMrtMode(true);
      expect(isSceneFBMrtMode()).toBe(true);
    });

    it("is idempotent for repeated identical sets", function () {
      setSceneFBMrtMode(false);
      setSceneFBMrtMode(false);
      expect(isSceneFBMrtMode()).toBe(false);
    });
  });

  describe("makeSceneFBTargets — MRT off", function () {
    beforeEach(function () {
      setSceneFBMrtMode(false);
    });

    it("returns a single-target array (opaque, default mask)", function () {
      const targets = makeSceneFBTargets("bgra8unorm");
      expect(targets.length).toBe(1);
      // Default opaque slot 0: no blend, no explicit writeMask (omitted
      // because 0xf is the WebGPU default — keeps pipeline-cache hashes
      // stable across Phase 1 conversions).
      expect(targets[0]).toEqual({ format: "bgra8unorm" });
    });

    it("emits the alpha-blend descriptor when translucent", function () {
      const targets = makeSceneFBTargets("bgra8unorm", { translucent: true });
      expect(targets.length).toBe(1);
      expect(targets[0]).toEqual({
        format: "bgra8unorm",
        blend: {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        },
      });
    });

    it("includes writeMask only when it is non-default (0x0)", function () {
      const targets = makeSceneFBTargets("bgra8unorm", { writeMask: 0x0 });
      expect(targets[0]).toEqual({ format: "bgra8unorm", writeMask: 0x0 });
    });

    it("omits writeMask when it is the default (0xf)", function () {
      const targets = makeSceneFBTargets("bgra8unorm", { writeMask: 0xf });
      // 0xf is the implicit WebGPU default → must NOT be serialized.
      expect(targets[0]).toEqual({ format: "bgra8unorm" });
      expect("writeMask" in targets[0]).toBe(false);
    });

    it("prefers an explicit blend over translucent's alpha blend", function () {
      const customBlend = {
        color: { srcFactor: "one", dstFactor: "one", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
      };
      const targets = makeSceneFBTargets("bgra8unorm", {
        translucent: true,
        blend: customBlend,
      });
      expect(targets[0]).toEqual({ format: "bgra8unorm", blend: customBlend });
    });

    it("combines explicit blend with a non-default writeMask", function () {
      const customBlend = {
        color: { srcFactor: "one", dstFactor: "one", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
      };
      const targets = makeSceneFBTargets("bgra8unorm", {
        blend: customBlend,
        writeMask: 0x0,
      });
      expect(targets[0]).toEqual({
        format: "bgra8unorm",
        blend: customBlend,
        writeMask: 0x0,
      });
    });

    it("combines translucent alpha blend with a non-default writeMask", function () {
      const targets = makeSceneFBTargets("bgra8unorm", {
        translucent: true,
        writeMask: 0x0,
      });
      expect(targets[0]).toEqual({
        format: "bgra8unorm",
        blend: {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        },
        writeMask: 0x0,
      });
    });

    it("passes the format through verbatim", function () {
      const targets = makeSceneFBTargets("rgba8unorm");
      expect(targets[0].format).toBe("rgba8unorm");
    });
  });

  describe("makeSceneFBTargets — MRT on", function () {
    beforeEach(function () {
      setSceneFBMrtMode(true);
    });

    it("returns a 2-target array with a placeholder slot 1", function () {
      const targets = makeSceneFBTargets("bgra8unorm");
      expect(targets.length).toBe(2);
      // Slot 0 keeps the same opaque shape as MRT-off.
      expect(targets[0]).toEqual({ format: "bgra8unorm" });
      // Slot 1 is a non-null placeholder: rgba16float with writeMask 0
      // (declares the target slot without requiring a @location(1) emit).
      expect(targets[1]).toEqual({ format: "rgba16float", writeMask: 0 });
    });

    it("slot 1 uses writeMask 0xf when emitsGBuffer is true", function () {
      const targets = makeSceneFBTargets("bgra8unorm", { emitsGBuffer: true });
      expect(targets.length).toBe(2);
      expect(targets[1]).toEqual({ format: "rgba16float", writeMask: 0xf });
    });

    it("slot 1 stays a placeholder (writeMask 0) when emitsGBuffer is false", function () {
      const targets = makeSceneFBTargets("bgra8unorm", { emitsGBuffer: false });
      expect(targets[1]).toEqual({ format: "rgba16float", writeMask: 0 });
    });

    it("slot 1 format is always the MRT normal-roughness format", function () {
      const targets = makeSceneFBTargets("bgra8unorm", { emitsGBuffer: true });
      expect(targets[1].format).toBe(MRT_NORMAL_ROUGHNESS_FORMAT);
    });

    it("preserves slot-0 translucent blend independently of slot 1", function () {
      const targets = makeSceneFBTargets("bgra8unorm", { translucent: true });
      expect(targets.length).toBe(2);
      expect(targets[0].blend.color.srcFactor).toBe("src-alpha");
      expect(targets[1]).toEqual({ format: "rgba16float", writeMask: 0 });
    });
  });

  describe("makeSceneFBTargetsMRT", function () {
    it("always returns 2 targets with a real (0xf) slot 1 — MRT off", function () {
      setSceneFBMrtMode(false);
      const targets = makeSceneFBTargetsMRT("bgra8unorm");
      expect(targets.length).toBe(2);
      expect(targets[0]).toEqual({ format: "bgra8unorm" });
      expect(targets[1]).toEqual({ format: "rgba16float", writeMask: 0xf });
    });

    it("always returns 2 targets with a real (0xf) slot 1 — MRT on", function () {
      setSceneFBMrtMode(true);
      const targets = makeSceneFBTargetsMRT("bgra8unorm");
      expect(targets.length).toBe(2);
      expect(targets[1]).toEqual({ format: "rgba16float", writeMask: 0xf });
    });

    it("applies slot-0 options (translucent blend)", function () {
      const targets = makeSceneFBTargetsMRT("bgra8unorm", { translucent: true });
      expect(targets[0]).toEqual({
        format: "bgra8unorm",
        blend: {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        },
      });
      // Slot 1 is unaffected by slot-0 options — always a real emit.
      expect(targets[1]).toEqual({ format: "rgba16float", writeMask: 0xf });
    });

    it("applies a non-default slot-0 writeMask", function () {
      const targets = makeSceneFBTargetsMRT("bgra8unorm", { writeMask: 0x0 });
      expect(targets[0]).toEqual({ format: "bgra8unorm", writeMask: 0x0 });
    });

    it("ignores emitsGBuffer for slot 1 (slot 1 is always 0xf here)", function () {
      const off = makeSceneFBTargetsMRT("bgra8unorm", { emitsGBuffer: false });
      expect(off[1]).toEqual({ format: "rgba16float", writeMask: 0xf });
    });
  });
});
