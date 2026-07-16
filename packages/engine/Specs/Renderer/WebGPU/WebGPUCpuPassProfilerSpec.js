import { WebGPUCpuPassProfiler } from "../../../Source/Renderer/WebGPU/WebGPUCpuPassProfiler.js";

// WebGPUCpuPassProfiler is a pure CPU class (no GPUDevice). These specs
// lock the C9-18 contract:
//   - disabled: beginPass/endPass/beginFrame are no-ops (I-10 — the hot
//     render sites wrap them in try/finally every frame; while disabled
//     they must not touch any Map or performance.now()).
//   - enabled: endPass accumulates elapsed ms into a single per-frame
//     bucket with += semantics, so repeated same-name begin/end pairs
//     across frusta add up (I-11 — same accumulation as time()).
//   - an unmatched endPass never fabricates a sample.

describe("Renderer/WebGPU/WebGPUCpuPassProfiler", function () {
  it("constructs disabled by default", function () {
    const p = new WebGPUCpuPassProfiler();
    expect(p.enabled).toBe(false);
    expect(p.getStats().enabled).toBe(false);
    expect(p.getStats().passes).toEqual({});
  });

  it("beginPass/endPass are no-ops while disabled (no bucket created)", function () {
    const p = new WebGPUCpuPassProfiler();
    p.beginFrame();
    p.beginPass("globe");
    p.endPass("globe");
    p.endFrame();
    // No window is ever created for a pass touched only while disabled.
    expect(p.getStats().passes).toEqual({});
    expect(p.getStats().frameCount).toBe(0);
  });

  it("does not call performance.now() while disabled", function () {
    const p = new WebGPUCpuPassProfiler();
    const spy = spyOn(performance, "now").and.callThrough();
    p.beginFrame();
    p.beginPass("globe");
    p.endPass("globe");
    p.endFrame();
    expect(spy).not.toHaveBeenCalled();
  });

  it("accumulates same-name begin/end pairs into one per-frame bucket", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 1000;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });
    p.beginFrame();
    // Frustum 0: 2 ms.
    p.beginPass("globe");
    t += 2;
    p.endPass("globe");
    // Frustum 1: 3 ms — must ADD to the same bucket, not overwrite.
    p.beginPass("globe");
    t += 3;
    p.endPass("globe");
    p.endFrame();

    const stats = p.getStats();
    expect(stats.frameCount).toBe(1);
    expect(stats.passes.globe).toBeDefined();
    expect(stats.passes.globe.lastMs).toEqualEpsilon(5, 1e-9);
    expect(stats.passes.globe.samples).toBe(1);
  });

  it("keeps distinct pass names in separate buckets", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });
    p.beginFrame();
    p.beginPass("globe");
    t += 4;
    p.endPass("globe");
    p.beginPass("opaque");
    t += 7;
    p.endPass("opaque");
    p.endFrame();

    const stats = p.getStats();
    expect(stats.passes.globe.lastMs).toEqualEpsilon(4, 1e-9);
    expect(stats.passes.opaque.lastMs).toEqualEpsilon(7, 1e-9);
  });

  it("an unmatched endPass fabricates no sample", function () {
    const p = new WebGPUCpuPassProfiler(true);
    spyOn(performance, "now").and.returnValue(0);
    p.beginFrame();
    p.endPass("never-begun");
    p.endFrame();
    expect(p.getStats().passes).toEqual({});
  });

  it("beginFrame clears any in-flight open pass", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });
    p.beginFrame();
    p.beginPass("globe"); // opened but never closed this frame
    t += 100;
    p.endFrame();
    // Next frame: an endPass with no matching begin must not use the
    // stale start from the previous frame.
    p.beginFrame();
    p.endPass("globe");
    p.endFrame();
    expect(p.getStats().passes).toEqual({});
  });

  it("matches time() accumulation for the same elapsed sequence", function () {
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    const viaClosure = new WebGPUCpuPassProfiler(true);
    viaClosure.beginFrame();
    viaClosure.time("globe", function () {
      t += 6;
    });
    viaClosure.time("globe", function () {
      t += 4;
    });
    viaClosure.endFrame();

    const viaBeginEnd = new WebGPUCpuPassProfiler(true);
    viaBeginEnd.beginFrame();
    viaBeginEnd.beginPass("globe");
    t += 6;
    viaBeginEnd.endPass("globe");
    viaBeginEnd.beginPass("globe");
    t += 4;
    viaBeginEnd.endPass("globe");
    viaBeginEnd.endFrame();

    expect(viaBeginEnd.getStats().passes.globe.lastMs).toEqualEpsilon(
      viaClosure.getStats().passes.globe.lastMs,
      1e-9,
    );
  });
});
