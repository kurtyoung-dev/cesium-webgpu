import {
  registerShaderTranslator,
  getActiveShaderTranslator,
  subscribeToShaderTranslatorChange,
  registerShaderPreprocessor,
  getActiveShaderPreprocessor,
  WGSLPassthroughTranslator,
  NotSupportedTranslator,
} from "../../../Source/Renderer/WebGPU/WebGPUShaderTranslator.js";

// These specs are pure-function / pure-object tests — the module is a
// module-global registry plus two built-in translator classes. None of
// it touches a GPUDevice, queue, or WASM module, so it's exactly the
// cheap deterministic coverage a Karma run should always get. The only
// shared state is the two module-level singletons (_activeTranslator,
// _activePreprocessor), so every spec resets them to null in afterEach
// to stay independent of run order.

describe("Renderer/WebGPU/WebGPUShaderTranslator", function () {
  afterEach(function () {
    // Restore the module-global registries to their pristine (cleared)
    // state so specs don't leak into one another.
    registerShaderTranslator(null);
    registerShaderPreprocessor(null);
  });

  describe("translator registry", function () {
    it("starts with no active translator after a clear", function () {
      registerShaderTranslator(null);
      expect(getActiveShaderTranslator()).toBeNull();
    });

    it("registerShaderTranslator stores the active translator", function () {
      const t = new WGSLPassthroughTranslator();
      registerShaderTranslator(t);
      expect(getActiveShaderTranslator()).toBe(t);
    });

    it("a later registration replaces the previous translator", function () {
      const a = new WGSLPassthroughTranslator();
      const b = new NotSupportedTranslator();
      registerShaderTranslator(a);
      registerShaderTranslator(b);
      expect(getActiveShaderTranslator()).toBe(b);
    });

    it("registering null clears the active translator", function () {
      registerShaderTranslator(new WGSLPassthroughTranslator());
      registerShaderTranslator(null);
      expect(getActiveShaderTranslator()).toBeNull();
    });
  });

  describe("subscribeToShaderTranslatorChange", function () {
    it("fires immediately with the current state (null) on subscribe", function () {
      registerShaderTranslator(null);
      const calls = [];
      const unsub = subscribeToShaderTranslatorChange((t) => calls.push(t));
      expect(calls.length).toBe(1);
      expect(calls[0]).toBeNull();
      unsub();
    });

    it("fires immediately with the current translator when one is active", function () {
      const active = new WGSLPassthroughTranslator();
      registerShaderTranslator(active);
      const calls = [];
      const unsub = subscribeToShaderTranslatorChange((t) => calls.push(t));
      expect(calls.length).toBe(1);
      expect(calls[0]).toBe(active);
      unsub();
    });

    it("notifies subscribers on subsequent registrations", function () {
      const calls = [];
      const unsub = subscribeToShaderTranslatorChange((t) => calls.push(t));
      // calls[0] is the immediate initial-state fire (null).
      const t = new WGSLPassthroughTranslator();
      registerShaderTranslator(t);
      expect(calls.length).toBe(2);
      expect(calls[1]).toBe(t);
      unsub();
    });

    it("returns an unsubscriber that stops further notifications", function () {
      const calls = [];
      const unsub = subscribeToShaderTranslatorChange((t) => calls.push(t));
      expect(calls.length).toBe(1); // initial fire
      unsub();
      registerShaderTranslator(new WGSLPassthroughTranslator());
      // No additional call after unsubscribe.
      expect(calls.length).toBe(1);
    });

    it("supports multiple independent subscribers", function () {
      const a = [];
      const b = [];
      const unsubA = subscribeToShaderTranslatorChange((t) => a.push(t));
      const unsubB = subscribeToShaderTranslatorChange((t) => b.push(t));
      // Each got its own immediate initial fire.
      expect(a.length).toBe(1);
      expect(b.length).toBe(1);
      const t = new NotSupportedTranslator();
      registerShaderTranslator(t);
      expect(a[1]).toBe(t);
      expect(b[1]).toBe(t);
      unsubA();
      unsubB();
    });

    it("swallows a throwing subscriber so others still run", function () {
      const good = [];
      const unsubBad = subscribeToShaderTranslatorChange(() => {
        throw new Error("subscriber blew up");
      });
      const unsubGood = subscribeToShaderTranslatorChange((t) => good.push(t));
      // The throwing subscriber must not prevent registration from
      // notifying the good one — registerShaderTranslator must not throw.
      const t = new WGSLPassthroughTranslator();
      expect(() => registerShaderTranslator(t)).not.toThrow();
      // good[0] = initial fire (null), good[1] = the registration.
      expect(good[good.length - 1]).toBe(t);
      unsubBad();
      unsubGood();
    });

    it("swallows a throwing subscriber on its own immediate fire", function () {
      // The immediate fire is wrapped in the same try/catch; subscribe
      // must return a usable unsubscriber even if the listener throws.
      let unsub;
      expect(() => {
        unsub = subscribeToShaderTranslatorChange(() => {
          throw new Error("immediate fire blew up");
        });
      }).not.toThrow();
      expect(typeof unsub).toBe("function");
      unsub();
    });
  });

  describe("preprocessor registry", function () {
    it("starts with no active preprocessor after a clear", function () {
      registerShaderPreprocessor(null);
      expect(getActiveShaderPreprocessor()).toBeNull();
    });

    it("registerShaderPreprocessor stores the active preprocessor", function () {
      const pp = {
        name: "test-preprocessor",
        supports: ["glsl"],
        preprocess: (source) => source,
      };
      registerShaderPreprocessor(pp);
      expect(getActiveShaderPreprocessor()).toBe(pp);
    });

    it("a later registration replaces the previous preprocessor", function () {
      const a = { name: "a", supports: ["glsl"], preprocess: (s) => s };
      const b = { name: "b", supports: ["glsl"], preprocess: (s) => s };
      registerShaderPreprocessor(a);
      registerShaderPreprocessor(b);
      expect(getActiveShaderPreprocessor()).toBe(b);
    });

    it("registering null clears the active preprocessor", function () {
      registerShaderPreprocessor({
        name: "p",
        supports: ["glsl"],
        preprocess: (s) => s,
      });
      registerShaderPreprocessor(null);
      expect(getActiveShaderPreprocessor()).toBeNull();
    });
  });

  describe("WGSLPassthroughTranslator", function () {
    it("declares its name and supported language", function () {
      const t = new WGSLPassthroughTranslator();
      expect(t.name).toBe("WGSL-passthrough");
      expect(t.supports).toEqual(["wgsl"]);
    });

    it("returns the source unchanged for wgsl", async function () {
      const t = new WGSLPassthroughTranslator();
      const src = "@vertex fn vertexMain() {}";
      const result = await t.translate(src, "vertex", "wgsl");
      expect(result.wgsl).toBe(src);
    });

    it("maps the vertex stage to entryPoint 'vertexMain'", async function () {
      const t = new WGSLPassthroughTranslator();
      const result = await t.translate("x", "vertex", "wgsl");
      expect(result.reflection.entryPoint).toBe("vertexMain");
      expect(result.reflection.stage).toBe("vertex");
    });

    it("maps the fragment stage to entryPoint 'fragmentMain'", async function () {
      const t = new WGSLPassthroughTranslator();
      const result = await t.translate("x", "fragment", "wgsl");
      expect(result.reflection.entryPoint).toBe("fragmentMain");
      expect(result.reflection.stage).toBe("fragment");
    });

    it("maps the compute stage to entryPoint 'computeMain'", async function () {
      const t = new WGSLPassthroughTranslator();
      const result = await t.translate("x", "compute", "wgsl");
      expect(result.reflection.entryPoint).toBe("computeMain");
      expect(result.reflection.stage).toBe("compute");
    });

    it("returns empty reflection arrays for passthrough", async function () {
      const t = new WGSLPassthroughTranslator();
      const result = await t.translate("x", "vertex", "wgsl");
      expect(result.reflection.uniformBuffers).toEqual([]);
      expect(result.reflection.textures).toEqual([]);
      expect(result.reflection.samplers).toEqual([]);
      expect(result.reflection.attributes).toEqual([]);
    });

    it("rejects non-wgsl input with a descriptive error", async function () {
      const t = new WGSLPassthroughTranslator();
      await expectAsync(
        t.translate("void main(){}", "vertex", "glsl"),
      ).toBeRejectedWithError(/cannot translate "glsl"/);
    });

    it("describe() returns a non-empty diagnostic string", function () {
      const t = new WGSLPassthroughTranslator();
      expect(typeof t.describe()).toBe("string");
      expect(t.describe().length).toBeGreaterThan(0);
    });
  });

  describe("NotSupportedTranslator", function () {
    it("has name 'NotSupported' and an empty supports list", function () {
      const t = new NotSupportedTranslator();
      expect(t.name).toBe("NotSupported");
      expect(t.supports).toEqual([]);
    });

    it("translate() rejects with the default message", async function () {
      const t = new NotSupportedTranslator();
      await expectAsync(t.translate()).toBeRejectedWithError(
        "GLSL shader translation not available in this build",
      );
    });

    it("translate() rejects with a custom message when provided", async function () {
      const t = new NotSupportedTranslator("no glsl here");
      await expectAsync(t.translate()).toBeRejectedWithError("no glsl here");
    });

    it("describe() embeds the active message", function () {
      const t = new NotSupportedTranslator("no glsl here");
      expect(t.describe()).toBe("NotSupported — no glsl here");
    });

    it("describe() embeds the default message when none is provided", function () {
      const t = new NotSupportedTranslator();
      expect(t.describe()).toBe(
        "NotSupported — GLSL shader translation not available in this build",
      );
    });
  });
});
