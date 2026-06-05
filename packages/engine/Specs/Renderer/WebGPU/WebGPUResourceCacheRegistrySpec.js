import { WebGPUResourceCacheRegistry } from "../../../Source/Renderer/WebGPU/WebGPUResourceCacheRegistry.js";
import WebGPUResourceCacheRegistryDefault from "../../../Source/Renderer/WebGPU/WebGPUResourceCacheRegistry.js";

// These specs are pure-logic tests — the registry is a plain dispatcher
// over `() => void` callbacks. It owns no GPU handles and needs no device,
// queue, or Cesium scene context, so a Karma run gets cheap, deterministic
// coverage of the registration order, per-entry error isolation, and the
// diagnostic getters that snapshot tests pin against.

describe("Renderer/WebGPU/WebGPUResourceCacheRegistry", function () {
  // A provider that always returns the same id; matches the
  // `() => string | undefined` constructor contract.
  function idProvider(id) {
    return function () {
      return id;
    };
  }

  describe("exports", function () {
    it("exposes the named export", function () {
      expect(WebGPUResourceCacheRegistry).toBeDefined();
      expect(typeof WebGPUResourceCacheRegistry).toBe("function");
    });

    it("default export is the same class as the named export", function () {
      expect(WebGPUResourceCacheRegistryDefault).toBe(
        WebGPUResourceCacheRegistry,
      );
    });
  });

  describe("construction", function () {
    it("starts empty", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      expect(registry.size).toBe(0);
      expect(registry.names).toEqual([]);
    });
  });

  describe("register", function () {
    it("increments size by one per registration", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      registry.register("pipelines", function () {});
      expect(registry.size).toBe(1);
      registry.register("bindGroups", function () {});
      expect(registry.size).toBe(2);
    });

    it("returns `this` so registration blocks can chain", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      const returned = registry.register("pipelines", function () {});
      expect(returned).toBe(registry);
    });

    it("supports fluent chaining", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      registry
        .register("a", function () {})
        .register("b", function () {})
        .register("c", function () {});
      expect(registry.size).toBe(3);
      expect(registry.names).toEqual(["a", "b", "c"]);
    });

    it("keeps duplicate names in registration order", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      registry.register("shaders", function () {});
      registry.register("shaders", function () {});
      expect(registry.size).toBe(2);
      expect(registry.names).toEqual(["shaders", "shaders"]);
    });
  });

  describe("names getter", function () {
    it("returns names in registration order", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      registry.register("first", function () {});
      registry.register("second", function () {});
      registry.register("third", function () {});
      expect(registry.names).toEqual(["first", "second", "third"]);
    });
  });

  describe("clearAll", function () {
    it("calls every registered clear callback", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      const calls = [];
      registry.register("a", function () {
        calls.push("a");
      });
      registry.register("b", function () {
        calls.push("b");
      });
      registry.clearAll();
      expect(calls).toEqual(["a", "b"]);
    });

    it("invokes callbacks in registration order", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      const order = [];
      registry.register("x", function () {
        order.push(1);
      });
      registry.register("y", function () {
        order.push(2);
      });
      registry.register("z", function () {
        order.push(3);
      });
      registry.clearAll();
      expect(order).toEqual([1, 2, 3]);
    });

    it("does not throw and keeps entries after clearing", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      let count = 0;
      registry.register("a", function () {
        count += 1;
      });
      registry.clearAll();
      registry.clearAll();
      // clearAll() runs callbacks; it does not drop registrations.
      expect(count).toBe(2);
      expect(registry.size).toBe(1);
    });

    it("is a no-op on an empty registry", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      expect(function () {
        registry.clearAll();
      }).not.toThrow();
    });

    it("isolates a throwing callback so later entries still run", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      const calls = [];
      const consoleSpy = spyOn(console, "error");
      registry.register("ok-before", function () {
        calls.push("ok-before");
      });
      registry.register("boom", function () {
        throw new Error("compile race");
      });
      registry.register("ok-after", function () {
        calls.push("ok-after");
      });
      expect(function () {
        registry.clearAll();
      }).not.toThrow();
      // The throwing entry does not block the entries on either side.
      expect(calls).toEqual(["ok-before", "ok-after"]);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it("logs the failing cache name and owning context id", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      const consoleSpy = spyOn(console, "error");
      registry.register("pipelines", function () {
        throw new Error("device lost");
      });
      registry.clearAll();
      const firstArg = consoleSpy.calls.argsFor(0)[0];
      expect(firstArg).toContain("ctx-a3f7");
      expect(firstArg).toContain("pipelines");
    });

    it("falls back to '?' when the context id provider returns undefined", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider(undefined));
      const consoleSpy = spyOn(console, "error");
      registry.register("pipelines", function () {
        throw new Error("device lost");
      });
      registry.clearAll();
      const firstArg = consoleSpy.calls.argsFor(0)[0];
      expect(firstArg).toContain("ctx-?");
    });

    it("logs once per failing entry", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      const consoleSpy = spyOn(console, "error");
      registry.register("a", function () {
        throw new Error("a");
      });
      registry.register("b", function () {});
      registry.register("c", function () {
        throw new Error("c");
      });
      registry.clearAll();
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("clear", function () {
    it("drops every registered entry", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      registry.register("a", function () {});
      registry.register("b", function () {});
      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.names).toEqual([]);
    });

    it("prevents previously-registered callbacks from running on clearAll", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      let count = 0;
      registry.register("a", function () {
        count += 1;
      });
      registry.clear();
      registry.clearAll();
      expect(count).toBe(0);
    });

    it("allows fresh registration after clearing", function () {
      const registry = new WebGPUResourceCacheRegistry(idProvider("a3f7"));
      registry.register("old", function () {});
      registry.clear();
      registry.register("new", function () {});
      expect(registry.size).toBe(1);
      expect(registry.names).toEqual(["new"]);
    });
  });
});
