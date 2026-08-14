import {
  CPU_SCENE_PHASE_NAMES,
  WebGPUCpuPassProfiler,
} from "../../../Source/Renderer/WebGPU/WebGPUCpuPassProfiler.js";

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
    expect(p.recordSceneFrameCpu(1, 10)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(p.getStats().lastFrame).toBeNull();
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

  it("accounts one logical Scene frame with exact current-frame pass totals", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    p.beginFrame(17);
    p.beginPass("globe");
    t += 2;
    p.endPass("globe");
    p.beginPass("globe");
    t += 3;
    p.endPass("globe");
    p.beginPass("opaque");
    t += 1;
    p.endPass("opaque");
    expect(p.recordSceneFrameCpu(17, 10)).toBe(true);

    const profile = p.getStats();
    const frame = profile.lastFrame;
    expect(profile.frameCount).toBe(1);
    expect(profile.frameAccounting.totalFrames).toBe(1);
    expect(profile.frameAccounting.samples).toBe(1);
    expect(frame.sequence).toBe(1);
    expect(frame.sceneFrameNumber).toBe(17);
    expect(frame.kind).toBe("scene");
    expect(frame.totalMs).toBe(10);
    expect(frame.profiledPassMs).toBe(6);
    expect(frame.unaccountedMs).toBe(4);
    expect(frame.overlapMs).toBe(0);
    expect(frame.coverageRatio).toBe(0.6);
    expect(frame.valid).toBe(true);
    expect(frame.passMs).toEqual({ globe: 5, opaque: 1 });
    expect(frame.profiledPassMs + frame.unaccountedMs).toBe(frame.totalMs);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.passMs)).toBe(true);
  });

  it("records an empty renderer frame as wholly unaccounted", function () {
    const p = new WebGPUCpuPassProfiler(true);
    p.beginFrame(23);
    expect(p.recordSceneFrameCpu(23, 8)).toBe(true);

    const frame = p.getStats().lastFrame;
    expect(frame.passMs).toEqual({});
    expect(frame.profiledPassMs).toBe(0);
    expect(frame.unaccountedMs).toBe(8);
    expect(frame.coverageRatio).toBe(0);
    expect(frame.valid).toBe(true);
  });

  it("defines zero-total zero-pass coverage as complete", function () {
    const p = new WebGPUCpuPassProfiler(true);
    p.beginFrame(24);
    expect(p.recordSceneFrameCpu(24, 0)).toBe(true);

    const frame = p.getStats().lastFrame;
    expect(frame.totalMs).toBe(0);
    expect(frame.profiledPassMs).toBe(0);
    expect(frame.unaccountedMs).toBe(0);
    expect(frame.overlapMs).toBe(0);
    expect(frame.coverageRatio).toBe(1);
    expect(frame.valid).toBe(true);
  });

  it("isolates a pick nested inside a normal Scene frame", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    p.beginFrame(31);
    p.beginPass("globe");
    t += 4;
    p.endPass("globe");

    p.beginFrame();
    p.beginPass("pick");
    t += 2;
    p.endPass("pick");
    p.endFrame();
    expect(p.getStats().lastFrame).toBeNull();

    expect(p.recordSceneFrameCpu(31, 10)).toBe(true);
    const profile = p.getStats();
    expect(profile.frameCount).toBe(2);
    expect(profile.frameAccounting.samples).toBe(1);
    expect(profile.lastFrame.passMs).toEqual({ globe: 4 });
    expect(profile.lastFrame.profiledPassMs).toBe(4);
    expect(profile.passes.pick.lastMs).toBe(2);
    expect(profile.passes.globe.lastMs).toBe(4);
  });

  it("fails closed on a mismatched frame token", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    p.beginFrame(40);
    p.beginPass("globe");
    t += 5;
    p.endPass("globe");
    expect(p.recordSceneFrameCpu(41, 10)).toBe(false);
    expect(p.getStats().lastFrame).toBeNull();
    expect(p.getStats().frameCount).toBe(0);

    p.beginFrame(41);
    p.beginPass("opaque");
    t += 3;
    p.endPass("opaque");
    expect(p.recordSceneFrameCpu(41, 9)).toBe(true);
    expect(p.getStats().lastFrame.passMs).toEqual({ opaque: 3 });
  });

  it("recovers a normal frame after an interrupted isolated pick", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    p.beginFrame();
    p.beginPass("pick");
    t += 100;
    // Model an exception before the isolated frame's finally block. The next
    // normal boundary must discard this partial pick rather than absorb it.
    p.beginFrame(45);
    p.beginPass("globe");
    t += 4;
    p.endPass("globe");
    expect(p.recordSceneFrameCpu(45, 9)).toBe(true);

    const profile = p.getStats();
    expect(profile.frameCount).toBe(1);
    expect(profile.passes.pick).toBeUndefined();
    expect(profile.lastFrame.passMs).toEqual({ globe: 4 });
    expect(profile.lastFrame.unaccountedMs).toBe(5);
  });

  it("cancels a failed Scene frame without changing the last good sample", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    p.beginFrame(60);
    p.beginPass("globe");
    t += 3;
    p.endPass("globe");
    expect(p.recordSceneFrameCpu(60, 8)).toBe(true);
    const goodFrame = p.getStats().lastFrame;

    p.beginFrame(61);
    p.beginPass("opaque");
    t += 5;
    p.endPass("opaque");
    expect(p.cancelSceneFrame(61)).toBe(true);
    expect(p.recordSceneFrameCpu(61, 9)).toBe(false);

    const profile = p.getStats();
    expect(profile.frameCount).toBe(1);
    expect(profile.frameAccounting.samples).toBe(1);
    expect(profile.lastFrame).toBe(goodFrame);
    expect(profile.passes.opaque).toBeUndefined();
  });

  it("rejects a frame with an open pass", function () {
    const p = new WebGPUCpuPassProfiler(true);
    spyOn(performance, "now").and.returnValue(0);

    p.beginFrame(62);
    p.beginPass("globe");
    expect(p.recordSceneFrameCpu(62, 8)).toBe(false);
    expect(p.getStats().lastFrame).toBeNull();
    expect(p.getStats().frameCount).toBe(0);
  });

  it("rejects non-finite or negative individual pass buckets", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 10;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    p.beginFrame(63);
    p.beginPass("negative");
    t = 5;
    p.endPass("negative");
    p.beginPass("positive");
    t = 20;
    p.endPass("positive");
    // The positive bucket makes the aggregate nonnegative; validation must
    // still reject the corrupt negative member rather than hiding it in a sum.
    expect(p.recordSceneFrameCpu(63, 30)).toBe(false);
    expect(p.getStats().lastFrame).toBeNull();
    expect(p.getStats().frameCount).toBe(0);
  });

  it("rejects NaN and Infinity pass buckets", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    p.beginFrame(64);
    p.beginPass("nan");
    t = Number.NaN;
    p.endPass("nan");
    expect(p.recordSceneFrameCpu(64, 10)).toBe(false);

    t = 0;
    p.beginFrame(65);
    p.beginPass("infinity");
    t = Number.POSITIVE_INFINITY;
    p.endPass("infinity");
    expect(p.recordSceneFrameCpu(65, 10)).toBe(false);
    expect(p.getStats().lastFrame).toBeNull();
    expect(p.getStats().frameCount).toBe(0);
  });

  it("nested Scene tokens fail closed without double publication", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    p.beginFrame(70);
    p.beginPass("outer");
    t += 2;
    p.endPass("outer");
    p.beginFrame(71);
    p.beginPass("inner");
    t += 3;
    p.endPass("inner");
    expect(p.recordSceneFrameCpu(71, 6)).toBe(true);
    expect(p.recordSceneFrameCpu(70, 9)).toBe(false);

    const profile = p.getStats();
    expect(profile.frameCount).toBe(1);
    expect(profile.frameAccounting.totalFrames).toBe(1);
    expect(profile.lastFrame.sceneFrameNumber).toBe(71);
    expect(profile.lastFrame.passMs).toEqual({ inner: 3 });
    expect(profile.passes.outer).toBeUndefined();
  });

  it("distinguishes total Scene frames from the rolling sample window", function () {
    const p = new WebGPUCpuPassProfiler(true);
    for (let frameNumber = 1; frameNumber <= 61; frameNumber++) {
      p.beginFrame(frameNumber);
      expect(p.recordSceneFrameCpu(frameNumber, 1)).toBe(true);
    }

    const profile = p.getStats();
    expect(profile.frameAccounting.totalFrames).toBe(61);
    expect(profile.frameAccounting.samples).toBe(60);
    expect(profile.lastFrame.sequence).toBe(61);
    expect(profile.lastFrame.sceneFrameNumber).toBe(61);
  });

  it("publishes nonnegative remainder and explicit overlap on invalid accounting", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    p.beginFrame(50);
    p.beginPass("overlap");
    t += 12;
    p.endPass("overlap");
    expect(p.recordSceneFrameCpu(50, 10)).toBe(true);

    const frame = p.getStats().lastFrame;
    expect(frame.totalMs).toBe(10);
    expect(frame.profiledPassMs).toBe(12);
    expect(frame.unaccountedMs).toBe(0);
    expect(frame.overlapMs).toBe(2);
    expect(frame.coverageRatio).toBe(1.2);
    expect(frame.valid).toBe(false);
    expect(frame.totalMs + frame.overlapMs).toBe(
      frame.profiledPassMs + frame.unaccountedMs,
    );
  });

  it("partitions attributed Scene time between coarse phases and named passes", function () {
    expect(Object.isFrozen(CPU_SCENE_PHASE_NAMES)).toBe(true);
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    expect(p.beginSceneFrame(80, "sceneUpdate")).toBe(0);
    t += 1;
    expect(p.markScenePhase(80, "frameState")).toBe(true);
    t += 2;
    expect(p.markScenePhase(80, "rendererOverhead")).toBe(true);
    t += 1;
    p.beginPass("globe");
    t += 3;
    p.endPass("globe");
    t += 2;
    expect(p.markScenePhase(80, "primitiveTraversal")).toBe(true);
    t += 1;
    expect(p.markScenePhase(80, "rendererOverhead")).toBe(true);
    t += 1;
    p.beginPass("globe");
    t += 2;
    p.endPass("globe");
    t += 3;

    expect(p.recordSceneFrameCpu(80, 16, 16)).toBe(true);
    const frame = p.getStats().lastFrame;
    expect(frame.passMs).toEqual({ globe: 5 });
    expect(frame.phaseMs.sceneUpdate).toBe(1);
    expect(frame.phaseMs.frameState).toBe(2);
    expect(frame.phaseMs.rendererOverhead).toBe(7);
    expect(frame.phaseMs.primitiveTraversal).toBe(1);
    expect(frame.phaseTotalMs).toBe(11);
    expect(frame.unaccountedMs).toBe(11);
    expect(frame.unattributedMs).toBe(0);
    expect(frame.attributionOverlapMs).toBe(0);
    expect(frame.attributionValid).toBe(true);
    expect(frame.valid).toBe(true);
    expect(frame.totalMs + frame.attributionOverlapMs).toBe(
      frame.profiledPassMs + frame.phaseTotalMs + frame.unattributedMs,
    );
    expect(Object.isFrozen(frame.phaseMs)).toBe(true);
  });

  it("does not clock phase markers without an attributed normal token", function () {
    const p = new WebGPUCpuPassProfiler();
    const spy = spyOn(performance, "now").and.callThrough();
    expect(p.beginSceneFrame(81, "sceneUpdate")).toBeUndefined();
    expect(p.markScenePhase(81, "frameState")).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    p.setEnabled(true);
    expect(p.markScenePhase(81, "frameState")).toBe(false);
    p.beginFrame();
    expect(p.markScenePhase(81, "frameState")).toBe(false);
    p.endFrame();
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an invalid runtime phase name before reading the clock", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    const spy = spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    expect(p.beginSceneFrame(83, "sceneUpdate")).toBe(0);
    t += 1;
    const callsBeforeInvalidMarker = spy.calls.count();
    expect(p.markScenePhase(83, "not-a-scene-phase")).toBe(false);
    expect(spy.calls.count()).toBe(callsBeforeInvalidMarker);
    expect(p.recordSceneFrameCpu(83, 1, 1)).toBe(false);
    expect(p.getStats().lastFrame).toBeNull();
  });

  it("keeps an isolated pick outside an attributed normal pass ledger", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    const start = p.beginSceneFrame(84, "sceneUpdate");
    t += 1;
    expect(p.markScenePhase(84, "afterRenderCreditTrace")).toBe(true);
    t += 1;

    p.beginFrame();
    p.beginPass("pick");
    t += 3;
    p.endPass("pick");
    p.endFrame();

    t += 2;
    expect(p.recordSceneFrameCpu(84, t - start, t)).toBe(true);
    const profile = p.getStats();
    const frame = profile.lastFrame;
    expect(frame.passMs).toEqual({});
    expect(frame.profiledPassMs).toBe(0);
    expect(frame.phaseMs.sceneUpdate).toBe(1);
    expect(frame.phaseMs.afterRenderCreditTrace).toBe(6);
    expect(frame.phaseTotalMs).toBe(7);
    expect(frame.unattributedMs).toBe(0);
    expect(frame.attributionValid).toBe(true);
    expect(profile.passes.pick.lastMs).toBe(3);
    expect(profile.frameCount).toBe(2);
  });

  it("fails attributed frames closed on overlapping passes or a phase switch during a pass", function () {
    const p = new WebGPUCpuPassProfiler(true);
    let t = 0;
    spyOn(performance, "now").and.callFake(function () {
      return t;
    });

    p.beginSceneFrame(82, "sceneUpdate");
    t += 1;
    p.beginPass("outer");
    p.beginPass("nested");
    expect(p.markScenePhase(82, "frameState")).toBe(false);
    t += 1;
    p.endPass("outer");
    expect(p.recordSceneFrameCpu(82, 2, 2)).toBe(false);
    expect(p.getStats().lastFrame).toBeNull();
  });
});
