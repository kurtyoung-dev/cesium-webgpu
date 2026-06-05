import {
  WebGPUShaderCache,
  BuiltInShaders,
  loadBuiltInShader,
} from "../../../Source/Renderer/WebGPU/WebGPUShaderCache.js";

describe("Renderer/WebGPU/WebGPUShaderCache", function () {
  // These specs cover ONLY the device-independent behavior of the shader
  // cache: constructor validation, cache-key + stats accounting, the
  // preprocessor passthrough, and the static helpers. No assertion below
  // touches a real GPUDevice — `createShaderModule` / `getCompilationInfo`
  // (the only GPU-bound calls, both inside the private `_compileShader`)
  // are never reached because every test either pre-seeds the internal
  // cache so the hit path returns first, or asserts on the validation /
  // accounting code that runs before any device call.
  //
  // The constructor only requires `defined(device)` to be true, so a plain
  // `{}` object is a sufficient stand-in for every pure path. The single
  // GPU-dependent public method that is NOT exercised here is `getShader`
  // on a cache MISS (it compiles via the device) — only its argument
  // validation, which runs before the device is touched, is covered.

  // A minimal fake device: `defined(device)` is the only thing the
  // constructor checks, and none of the tested methods call into it.
  function makeCache() {
    return new WebGPUShaderCache({});
  }

  // A tiny fake cache entry shaped like ShaderCacheEntry. We inject it
  // directly into the private `_cache` Map (runtime field name `_cache`)
  // to test the Map-accounting methods without compiling anything.
  function fakeEntry(name) {
    return {
      module: { __fakeModule: name },
      code: "// fake",
      entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
      timestamp: 0,
    };
  }

  describe("constructor", function () {
    it("throws a DeveloperError when no device is supplied", function () {
      expect(function () {
        return new WebGPUShaderCache(undefined);
      }).toThrowError(/device is required/);
    });

    it("constructs with a defined device and starts empty", function () {
      const cache = makeCache();
      expect(cache.getCachedNames()).toEqual([]);
      expect(cache.getStats().size).toBe(0);
      expect(cache.getStats().pending).toBe(0);
    });

    it("exposes a preprocessor and a library instance", function () {
      const cache = makeCache();
      expect(cache.preprocessor).toBeDefined();
      expect(cache.library).toBeDefined();
    });
  });

  describe("getShader argument validation", function () {
    // The validation runs before any device interaction, so the rejected
    // promises here never reach `createShaderModule`.
    it("rejects when descriptor is undefined", async function () {
      const cache = makeCache();
      await expectAsync(cache.getShader(undefined)).toBeRejectedWithError(
        /descriptor is required/,
      );
    });

    it("rejects when descriptor.name is missing", async function () {
      const cache = makeCache();
      await expectAsync(
        cache.getShader({ code: "// x" }),
      ).toBeRejectedWithError(/descriptor.name is required/);
    });

    it("rejects when descriptor.code is missing", async function () {
      const cache = makeCache();
      await expectAsync(cache.getShader({ name: "Foo" })).toBeRejectedWithError(
        /descriptor.code is required/,
      );
    });
  });

  describe("cache accounting (has / remove / clear / getCachedNames)", function () {
    it("reports has() against pre-seeded entries", function () {
      const cache = makeCache();
      expect(cache.has("Foo")).toBe(false);
      cache._cache.set("Foo", fakeEntry("Foo"));
      expect(cache.has("Foo")).toBe(true);
    });

    it("getCachedNames() lists keys; size tracks count", function () {
      const cache = makeCache();
      cache._cache.set("A", fakeEntry("A"));
      cache._cache.set("B", fakeEntry("B"));
      expect(cache.getCachedNames().sort()).toEqual(["A", "B"]);
      expect(cache.getStats().size).toBe(2);
    });

    it("remove() deletes a present key and reports the result", function () {
      const cache = makeCache();
      cache._cache.set("A", fakeEntry("A"));
      expect(cache.remove("A")).toBe(true);
      expect(cache.has("A")).toBe(false);
      // Removing an absent key returns false.
      expect(cache.remove("A")).toBe(false);
    });

    it("clear() empties both the cache and the pending map", function () {
      const cache = makeCache();
      cache._cache.set("A", fakeEntry("A"));
      cache._pendingCompilations.set("P", Promise.resolve({}));
      cache.clear();
      expect(cache.getStats().size).toBe(0);
      expect(cache.getStats().pending).toBe(0);
    });
  });

  describe("getCachedShader", function () {
    it("returns undefined and does not count a hit on a miss", function () {
      const cache = makeCache();
      expect(cache.getCachedShader("Nope")).toBeUndefined();
      expect(cache.getStats().hits).toBe(0);
    });

    it("returns the cached module and counts a hit on a present key", function () {
      const cache = makeCache();
      const entry = fakeEntry("Hit");
      cache._cache.set("Hit", entry);
      expect(cache.getCachedShader("Hit")).toBe(entry.module);
      expect(cache.getStats().hits).toBe(1);
    });
  });

  describe("getStats / resetStats", function () {
    it("starts all counters at zero with hitRate 0 (avoids 0/0 NaN)", function () {
      const cache = makeCache();
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.compilations).toBe(0);
      expect(stats.errors).toBe(0);
      // hits / (hits + misses) is 0/0 = NaN, coerced to 0 by `|| 0`.
      expect(stats.hitRate).toBe(0);
    });

    it("computes hitRate as hits / (hits + misses) once there are hits", function () {
      const cache = makeCache();
      // Pre-seed two entries; three getCachedShader hits drive the rate.
      cache._cache.set("A", fakeEntry("A"));
      cache.getCachedShader("A");
      cache.getCachedShader("A");
      cache.getCachedShader("A");
      const stats = cache.getStats();
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(0);
      // 3 / (3 + 0) === 1.
      expect(stats.hitRate).toBe(1);
    });

    it("resetStats() zeroes the counters but leaves cached entries intact", function () {
      const cache = makeCache();
      cache._cache.set("A", fakeEntry("A"));
      cache.getCachedShader("A"); // hits -> 1
      cache.resetStats();
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.compilations).toBe(0);
      expect(stats.errors).toBe(0);
      // Entry survives a stats reset; size still reflects it.
      expect(stats.size).toBe(1);
    });
  });

  describe("getPreprocessedShader cache key", function () {
    // The cache key is `${name}:${defines.sort().join(",")}`. By pre-seeding
    // that exact key we force the hit path, which returns the cached module
    // and increments hits WITHOUT ever calling the device.
    it("hits a pre-seeded key built from name + no defines", async function () {
      const cache = makeCache();
      const entry = fakeEntry("Shader:");
      cache._cache.set("Shader:", entry);
      const module = await cache.getPreprocessedShader("Shader", "// code");
      expect(module).toBe(entry.module);
      expect(cache.getStats().hits).toBe(1);
    });

    it("sorts defines into the cache key so order does not matter", async function () {
      const cache = makeCache();
      // sort() => ["A","B","C"] regardless of input order => "Shader:A,B,C".
      const entry = fakeEntry("Shader:A,B,C");
      cache._cache.set("Shader:A,B,C", entry);
      const module = await cache.getPreprocessedShader("Shader", "// code", {
        defines: ["C", "A", "B"],
      });
      expect(module).toBe(entry.module);
      expect(cache.getStats().hits).toBe(1);
    });
  });

  describe("preprocessOnly", function () {
    // The preprocessor is a pure (source, options) -> string function. With
    // no `#import` directives and no `csm_*` references, the source passes
    // through to the tail of the resolved output unchanged.
    it("returns import-free source containing the original body", function () {
      const cache = makeCache();
      const src = "fn main() -> f32 { return 1.0; }";
      const out = cache.preprocessOnly(src);
      expect(typeof out).toBe("string");
      expect(out).toContain("fn main() -> f32 { return 1.0; }");
    });

    it("emits a typed const declaration for a 'NAME value' define", function () {
      const cache = makeCache();
      const out = cache.preprocessOnly("// body", { defines: ["MAX 4"] });
      // inferDefineType maps a suffix-less positive integer to u32 (with a
      // 'u' literal suffix) "for backward compat" — see the source comment.
      expect(out).toContain("const MAX: u32 = 4u;");
    });
  });

  describe("destroy / isDestroyed", function () {
    it("isDestroyed() reports false (no destroyed flag tracked)", function () {
      const cache = makeCache();
      expect(cache.isDestroyed()).toBe(false);
    });

    it("destroy() clears the cache", function () {
      const cache = makeCache();
      cache._cache.set("A", fakeEntry("A"));
      cache.destroy();
      expect(cache.getStats().size).toBe(0);
      // Still reports not-destroyed (it only delegates to clear()).
      expect(cache.isDestroyed()).toBe(false);
    });
  });

  describe("BuiltInShaders constants", function () {
    it("pins the documented built-in shader names", function () {
      expect(BuiltInShaders.BASIC_COLOR).toBe("BasicColor");
      expect(BuiltInShaders.BASIC_TEXTURED).toBe("BasicTextured");
      expect(BuiltInShaders.PHONG_LIGHTING).toBe("PhongLighting");
      expect(BuiltInShaders.PBR_METALLIC_ROUGHNESS).toBe(
        "PBRMetallicRoughness",
      );
    });
  });

  describe("loadBuiltInShader", function () {
    it("rejects as not-yet-implemented", async function () {
      const cache = makeCache();
      await expectAsync(
        loadBuiltInShader(cache, BuiltInShaders.PHONG_LIGHTING),
      ).toBeRejectedWithError(/not yet implemented/);
    });
  });
});
