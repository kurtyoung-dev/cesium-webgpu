import WebGPUEffectsStateCache from "../../../Source/Renderer/WebGPU/WebGPUEffectsStateCache.js";

describe("Renderer/WebGPU/WebGPUEffectsStateCache", function () {
  function createHarness(maxGroups) {
    const cache = new WebGPUEffectsStateCache({ maxGroups });
    let created = 0;
    let writes = 0;
    const retired = [];
    return {
      cache,
      acquire(key, bits, frame) {
        return cache.acquire(
          key,
          bits,
          frame,
          function () {
            return { id: ++created };
          },
          function () {
            writes++;
          },
          function (resources) {
            retired.push(...resources);
          },
        );
      },
      get created() {
        return created;
      },
      get writes() {
        return writes;
      },
      retired,
    };
  }

  it("does not grow when camera-dependent bytes change across frames", function () {
    const harness = createHarness(16);
    for (let frame = 1; frame <= 1000; frame++) {
      harness.acquire("view-1|resources-1", new Uint32Array([frame, 2]), frame);
    }

    const diagnostics = harness.cache.getDiagnostics(480);
    expect(harness.created).toBe(1);
    expect(harness.writes).toBe(1000);
    expect(diagnostics.groupCount).toBe(1);
    expect(diagnostics.slotCount).toBe(1);
    expect(diagnostics.liveBytes).toBe(480);
  });

  it("uploads identical per-tile bytes only once per version", function () {
    const harness = createHarness(16);
    const bits = new Uint32Array([10, 20, 30]);
    let first;
    for (let tile = 0; tile < 200; tile++) {
      const resource = harness.acquire("globe-view", bits, 7);
      first ??= resource;
      expect(resource).toBe(first);
    }

    const diagnostics = harness.cache.getDiagnostics(480);
    expect(harness.created).toBe(1);
    expect(harness.writes).toBe(1);
    expect(diagnostics.skippedWrites).toBe(199);
  });

  it("keeps distinct same-frame variants isolated and reuses their slots", function () {
    const harness = createHarness(16);
    const first = harness.acquire("model", new Uint32Array([1]), 1);
    const second = harness.acquire("model", new Uint32Array([2]), 1);
    expect(second).not.toBe(first);

    const nextFirst = harness.acquire("model", new Uint32Array([3]), 2);
    const nextSecond = harness.acquire("model", new Uint32Array([4]), 2);
    expect(nextFirst).toBe(first);
    expect(nextSecond).toBe(second);
    expect(harness.created).toBe(2);
    expect(harness.cache.getDiagnostics(480).slotCount).toBe(2);
  });

  it("evicts only groups not referenced by the current frame", function () {
    const harness = createHarness(2);
    harness.acquire("old-a", new Uint32Array([2]), 1);
    harness.acquire("old-b", new Uint32Array([3]), 1);
    const current = harness.acquire("current", new Uint32Array([1]), 3);

    const diagnostics = harness.cache.getDiagnostics(480);
    expect(diagnostics.groupCount).toBe(2);
    expect(diagnostics.evictions).toBe(1);
    expect(harness.retired.length).toBe(1);
    expect(harness.retired).not.toContain(current);
  });
});
