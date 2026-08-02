import {
  DESIRED_FEATURES,
  WebGPUFeatureFlags,
} from "../../../Source/Renderer/WebGPU/WebGPUFeatureFlags.js";

// Pure-function / pure-state tests — no GPU device required. The class
// only reads `adapter.features.has(name)` and copies plain Sets, so a
// minimal stub adapter (an object exposing a `features` Set) exercises
// every code path without touching a real GPUAdapter/GPUDevice/queue.

describe("Renderer/WebGPU/WebGPUFeatureFlags", function () {
  describe("DESIRED_FEATURES", function () {
    // The list is priority-ordered and load-bearing: buildRequestList
    // iterates it in order, and the comments pair each entry with a work
    // item. An accidental reorder/removal should fail fast in CI.
    it("contains the full priority-ordered feature list", function () {
      expect(DESIRED_FEATURES).toEqual([
        "float32-filterable",
        "core-features-and-limits",
        "texture-formats-tier1",
        "clip-distances",
        "dual-source-blending",
        "rg11b10ufloat-renderable",
        "timestamp-query",
        "shader-f16",
        "indirect-first-instance",
        "subgroups",
        "bgra8unorm-storage",
        "texture-compression-bc",
        "texture-compression-etc2",
        "texture-compression-astc",
      ]);
    });

    it("has exactly 14 entries with no duplicates", function () {
      expect(DESIRED_FEATURES.length).toBe(14);
      expect(new Set(DESIRED_FEATURES).size).toBe(14);
    });

    it("lists float32-filterable first (terrain heightmap filtering)", function () {
      expect(DESIRED_FEATURES[0]).toBe("float32-filterable");
    });
  });

  describe("buildRequestList", function () {
    // A stub adapter is just an object with a `features` Set — the method
    // only calls `adapter.features.has(...)`.
    function stubAdapter(supported) {
      return { features: new Set(supported) };
    }

    it("returns an empty array when the adapter supports nothing", function () {
      const flags = new WebGPUFeatureFlags();
      const list = flags.buildRequestList(stubAdapter([]));
      expect(list).toEqual([]);
    });

    it("requests core limits only when the adapter exposes them", function () {
      const flags = new WebGPUFeatureFlags();
      expect(
        flags.buildRequestList(stubAdapter(["core-features-and-limits"])),
      ).toEqual(["core-features-and-limits"]);
      expect(flags.buildRequestList(stubAdapter([]))).not.toContain(
        "core-features-and-limits",
      );
    });

    it("includes only adapter-supported DESIRED_FEATURES entries", function () {
      const flags = new WebGPUFeatureFlags();
      const list = flags.buildRequestList(
        stubAdapter(["float32-filterable", "timestamp-query"]),
      );
      // Order within the result follows Set insertion order; with no
      // user-requested features it is the DESIRED_FEATURES iteration order.
      expect(list).toEqual(["float32-filterable", "timestamp-query"]);
    });

    it("ignores adapter features that are not in DESIRED_FEATURES", function () {
      const flags = new WebGPUFeatureFlags();
      const list = flags.buildRequestList(
        stubAdapter(["depth-clip-control", "float32-filterable"]),
      );
      expect(list).toEqual(["float32-filterable"]);
    });

    it("forwards user-requested features verbatim even if unsupported", function () {
      const flags = new WebGPUFeatureFlags();
      const list = flags.buildRequestList(stubAdapter([]), [
        "depth-clip-control",
      ]);
      expect(list).toEqual(["depth-clip-control"]);
    });

    it("merges user-requested with auto-detected features", function () {
      const flags = new WebGPUFeatureFlags();
      const list = flags.buildRequestList(stubAdapter(["clip-distances"]), [
        "depth-clip-control",
      ]);
      // User-requested are seeded into the Set first, then matching
      // DESIRED_FEATURES are added.
      expect(list).toEqual(["depth-clip-control", "clip-distances"]);
    });

    it("dedupes when a user-requested feature is also auto-detected", function () {
      const flags = new WebGPUFeatureFlags();
      const list = flags.buildRequestList(stubAdapter(["shader-f16"]), [
        "shader-f16",
      ]);
      expect(list).toEqual(["shader-f16"]);
      expect(list.length).toBe(1);
    });

    it("does not mutate internal enabled state", function () {
      const flags = new WebGPUFeatureFlags();
      flags.buildRequestList(stubAdapter(["shader-f16", "subgroups"]));
      // buildRequestList is documented as pure over its inputs — the
      // enabled set is only populated by markEnabled.
      expect(flags.enabledList).toEqual([]);
      expect(flags.has("shader-f16")).toBe(false);
    });

    it("requests every DESIRED_FEATURES entry when the adapter supports all", function () {
      const flags = new WebGPUFeatureFlags();
      const list = flags.buildRequestList(stubAdapter(DESIRED_FEATURES));
      expect(list).toEqual(Array.from(DESIRED_FEATURES));
    });
  });

  describe("markEnabled / has / enabled / enabledList", function () {
    it("records granted device features so has() answers true", function () {
      const flags = new WebGPUFeatureFlags();
      flags.markEnabled(new Set(["timestamp-query", "shader-f16"]));
      expect(flags.has("timestamp-query")).toBe(true);
      expect(flags.has("shader-f16")).toBe(true);
    });

    it("returns false for features the device did not grant", function () {
      const flags = new WebGPUFeatureFlags();
      flags.markEnabled(new Set(["timestamp-query"]));
      expect(flags.has("clip-distances")).toBe(false);
    });

    it("defaults to no enabled features before markEnabled", function () {
      const flags = new WebGPUFeatureFlags();
      expect(flags.has("float32-filterable")).toBe(false);
      expect(flags.enabledList).toEqual([]);
    });

    it("replaces prior state on a second markEnabled call", function () {
      const flags = new WebGPUFeatureFlags();
      flags.markEnabled(new Set(["timestamp-query"]));
      flags.markEnabled(new Set(["shader-f16"]));
      expect(flags.has("timestamp-query")).toBe(false);
      expect(flags.has("shader-f16")).toBe(true);
    });

    it("enabledList reflects every granted feature", function () {
      const flags = new WebGPUFeatureFlags();
      flags.markEnabled(new Set(["a", "b", "c"]));
      // Order is arbitrary per the JSDoc; compare as sets.
      expect(new Set(flags.enabledList)).toEqual(new Set(["a", "b", "c"]));
      expect(flags.enabledList.length).toBe(3);
    });

    it("copies the input set so later external mutation is ignored", function () {
      const flags = new WebGPUFeatureFlags();
      const deviceFeatures = new Set(["timestamp-query"]);
      flags.markEnabled(deviceFeatures);
      deviceFeatures.add("shader-f16");
      // markEnabled does `new Set(deviceFeatures)`, so the later add does
      // not leak into the recorded state.
      expect(flags.has("shader-f16")).toBe(false);
    });

    it("exposes a read-only view via the enabled getter", function () {
      const flags = new WebGPUFeatureFlags();
      flags.markEnabled(new Set(["clip-distances", "subgroups"]));
      const view = flags.enabled;
      expect(view.has("clip-distances")).toBe(true);
      expect(view.has("subgroups")).toBe(true);
      expect(view.size).toBe(2);
    });
  });

  describe("clear", function () {
    it("drops all enabled features", function () {
      const flags = new WebGPUFeatureFlags();
      flags.markEnabled(new Set(["timestamp-query", "shader-f16"]));
      flags.clear();
      expect(flags.has("timestamp-query")).toBe(false);
      expect(flags.has("shader-f16")).toBe(false);
      expect(flags.enabledList).toEqual([]);
      expect(flags.enabled.size).toBe(0);
    });
  });

  describe("default export", function () {
    it("is the WebGPUFeatureFlags class", function () {
      // Construct via the named export and confirm instance shape.
      const flags = new WebGPUFeatureFlags();
      expect(typeof flags.buildRequestList).toBe("function");
      expect(typeof flags.markEnabled).toBe("function");
      expect(typeof flags.has).toBe("function");
      expect(typeof flags.clear).toBe("function");
    });
  });
});
