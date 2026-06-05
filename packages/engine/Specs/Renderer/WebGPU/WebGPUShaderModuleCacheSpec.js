import { WebGPUShaderModuleCache } from "../../../Source/Renderer/WebGPU/WebGPUShaderModuleCache.js";

// WebGPUShaderModuleCache's only device-touching call is
// `device.createShaderModule` inside `getOrCreate` (and, transitively,
// `prewarm`). Everything that makes this class correct — the
// `(sourceId & 0xff) | ((defines & 0xffffff) << 8)` key packing, the
// dedup-on-hit behaviour, `size()` accounting, and `destroy()` clearing
// — is observable through a tiny capturing stub device that returns a
// sentinel object and records every `createShaderModule` call. No live
// GPUDevice, queue, or async setup is required, so these run in the
// Karma headless browser with zero GPU dependency.
//
// Source string is kept free of `//>>ifdef` directives on purpose: with
// no directives, `preprocess(source, defines)` is a pure pass-through
// that never consults the define registry, so synthetic `defines`
// values (including out-of-range bits) exercise the key-masking math
// without tripping the preprocessor's "unknown define" throw.
function makeStubDevice() {
  const device = {
    calls: [],
    createShaderModule(descriptor) {
      const module = {
        __isShaderModule: true,
        index: device.calls.length,
        code: descriptor.code,
        label: descriptor.label,
      };
      device.calls.push(descriptor);
      return module;
    },
  };
  return device;
}

describe("Renderer/WebGPU/WebGPUShaderModuleCache", function () {
  describe("constructor + size()", function () {
    it("starts empty", function () {
      const cache = new WebGPUShaderModuleCache(makeStubDevice());
      expect(cache.size()).toBe(0);
    });

    it("does not call createShaderModule at construction time", function () {
      const device = makeStubDevice();
      // eslint-disable-next-line no-unused-vars
      const cache = new WebGPUShaderModuleCache(device);
      expect(device.calls.length).toBe(0);
    });
  });

  describe("getOrCreate", function () {
    it("compiles and returns the stub module on a miss", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      const module = cache.getOrCreate(1, "fn main() {}", 0, "label-a");
      expect(module.__isShaderModule).toBe(true);
      expect(device.calls.length).toBe(1);
      expect(cache.size()).toBe(1);
    });

    it("forwards the preprocessed code and label to createShaderModule", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      // Directive-free source round-trips byte-identically through
      // preprocess() (split/join on "\n"), so the forwarded code equals
      // the input source.
      const source = "// header\nfn main() {}";
      cache.getOrCreate(2, source, 0, "MyLabel");
      expect(device.calls[0].code).toBe(source);
      expect(device.calls[0].label).toBe("MyLabel");
    });

    it("returns the same cached module for an identical key (no recompile)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      const first = cache.getOrCreate(7, "src", 0x000003, "first");
      const second = cache.getOrCreate(7, "src", 0x000003, "second");
      expect(second).toBe(first);
      // Hit path must not call the device again, even with a new label.
      expect(device.calls.length).toBe(1);
      expect(cache.size()).toBe(1);
    });

    it("compiles distinct modules for different sourceIds", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      const a = cache.getOrCreate(1, "src", 0, "a");
      const b = cache.getOrCreate(2, "src", 0, "b");
      expect(b).not.toBe(a);
      expect(device.calls.length).toBe(2);
      expect(cache.size()).toBe(2);
    });

    it("compiles distinct modules for different defines on the same source", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      const none = cache.getOrCreate(1, "src", 0x000000, "none");
      const bit0 = cache.getOrCreate(1, "src", 0x000001, "bit0");
      expect(bit0).not.toBe(none);
      expect(device.calls.length).toBe(2);
      expect(cache.size()).toBe(2);
    });
  });

  describe("cache-key packing: (sourceId & 0xff) | ((defines & 0xffffff) << 8)", function () {
    it("treats sourceId 0x00 and 0x100 as the same key (low 8 bits only)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      // 0x100 & 0xff === 0x00, so these collide to one cache entry.
      const a = cache.getOrCreate(0x00, "src", 0, "a");
      const b = cache.getOrCreate(0x100, "src", 0, "b");
      expect(b).toBe(a);
      expect(device.calls.length).toBe(1);
      expect(cache.size()).toBe(1);
    });

    it("keeps sourceId 0x01 distinct from sourceId 0x101 only via the masked low byte", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      // Both mask to 0x01; same key, single compile.
      cache.getOrCreate(0x01, "src", 0, "a");
      cache.getOrCreate(0x101, "src", 0, "b");
      expect(cache.size()).toBe(1);
    });

    it("treats defines 0x000000 and 0x1000000 as the same key (low 24 bits only)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      // 0x1000000 & 0xffffff === 0, so it aliases the no-defines entry.
      const a = cache.getOrCreate(5, "src", 0x000000, "a");
      const b = cache.getOrCreate(5, "src", 0x1000000, "b");
      expect(b).toBe(a);
      expect(device.calls.length).toBe(1);
    });

    it("separates the sourceId byte from the defines field (no cross-talk)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      // sourceId=0x01 defines=0x000000 packs to key 0x00000001.
      // sourceId=0x00 defines=0x000001 packs to key 0x00000100.
      // Different keys → two compiles; proves defines are shifted left 8
      // and don't bleed into the source-id byte.
      const a = cache.getOrCreate(0x01, "src", 0x000000, "a");
      const b = cache.getOrCreate(0x00, "src", 0x000001, "b");
      expect(b).not.toBe(a);
      expect(cache.size()).toBe(2);
    });

    it("packs the full 24-bit defines field without overflow into a recompile", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      // 0xffffff is the maximum representable defines field. Asking for
      // it twice must hit the cache the second time.
      const first = cache.getOrCreate(0xff, "src", 0xffffff, "max");
      const second = cache.getOrCreate(0xff, "src", 0xffffff, "max-again");
      expect(second).toBe(first);
      expect(device.calls.length).toBe(1);
    });
  });

  describe("prewarm", function () {
    it("compiles one module per requested define set", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      cache.prewarm(3, "src", [0x000000, 0x000001, 0x000002], "Globe");
      expect(device.calls.length).toBe(3);
      expect(cache.size()).toBe(3);
    });

    it("is idempotent — re-prewarming the same sets does not recompile", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      const sets = [0x000000, 0x000001];
      cache.prewarm(3, "src", sets, "Globe");
      cache.prewarm(3, "src", sets, "Globe");
      expect(device.calls.length).toBe(2);
      expect(cache.size()).toBe(2);
    });

    it("deduplicates define sets that collide under the 24-bit mask", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      // 0x000000 and 0x1000000 both mask to 0 → a single entry.
      cache.prewarm(3, "src", [0x000000, 0x1000000], "Globe");
      expect(device.calls.length).toBe(1);
      expect(cache.size()).toBe(1);
    });

    it("labels each variant with the zero-padded hex defines suffix", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      cache.prewarm(3, "src", [0x000000, 0x0000ab], "Globe");
      expect(device.calls[0].label).toBe("Globe (defines=0x000000)");
      expect(device.calls[1].label).toBe("Globe (defines=0x0000ab)");
    });

    it("compiles nothing for an empty define-set list", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      cache.prewarm(3, "src", [], "Globe");
      expect(device.calls.length).toBe(0);
      expect(cache.size()).toBe(0);
    });
  });

  describe("destroy", function () {
    it("clears all cached module references", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      cache.getOrCreate(1, "src", 0, "a");
      cache.getOrCreate(2, "src", 0, "b");
      expect(cache.size()).toBe(2);
      cache.destroy();
      expect(cache.size()).toBe(0);
    });

    it("recompiles after destroy (entries are truly gone, not stale-hit)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUShaderModuleCache(device);
      const before = cache.getOrCreate(1, "src", 0, "a");
      cache.destroy();
      const after = cache.getOrCreate(1, "src", 0, "a");
      expect(after).not.toBe(before);
      expect(device.calls.length).toBe(2);
      expect(cache.size()).toBe(1);
    });
  });
});
