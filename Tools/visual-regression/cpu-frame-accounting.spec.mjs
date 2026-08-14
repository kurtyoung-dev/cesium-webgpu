import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CPU_SCENE_PHASE_NAMES,
  WebGPUCpuPassProfiler,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCpuPassProfiler.ts";

function withDeterministicClock(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let now = 0;
  let calls = 0;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: {
      now() {
        calls++;
        return now;
      },
    },
  });
  try {
    run({
      advance(ms) {
        now += ms;
      },
      set(value) {
        now = value;
      },
      now() {
        return now;
      },
      calls() {
        return calls;
      },
    });
  } finally {
    Object.defineProperty(globalThis, "performance", descriptor);
  }
}

test("disabled whole-frame path performs no clock work or publication", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler();
    profiler.beginFrame(1);
    profiler.beginPass("globe");
    profiler.endPass("globe");
    assert.equal(profiler.recordSceneFrameCpu(1, 10), false);
    assert.equal(clock.calls(), 0);
    assert.equal(profiler.getStats().frameAccounting, null);
    assert.equal(profiler.getStats().lastFrame, null);
  });
});

test("one logical frame conserves multi-frustum pass time exactly", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    profiler.beginFrame(100);
    profiler.beginPass("globe");
    clock.advance(2);
    profiler.endPass("globe");
    profiler.beginPass("globe");
    clock.advance(3);
    profiler.endPass("globe");
    profiler.beginPass("opaque");
    clock.advance(1);
    profiler.endPass("opaque");

    assert.equal(profiler.recordSceneFrameCpu(100, 10), true);
    const profile = profiler.getStats();
    const frame = profile.lastFrame;
    assert.deepEqual(frame.passMs, { globe: 5, opaque: 1 });
    assert.equal(frame.profiledPassMs, 6);
    assert.equal(frame.unaccountedMs, 4);
    assert.equal(frame.overlapMs, 0);
    assert.equal(frame.coverageRatio, 0.6);
    assert.equal(frame.valid, true);
    assert.equal(
      frame.totalMs + frame.overlapMs,
      frame.profiledPassMs + frame.unaccountedMs,
    );
    assert.equal(profile.frameAccounting.samples, 1);
    assert.equal(profile.frameAccounting.totalFrames, 1);
    assert.equal(Object.isFrozen(frame), true);
    assert.equal(Object.isFrozen(frame.passMs), true);
  });
});

test("coarse phases and named passes form one exact exclusive partition", () => {
  assert.equal(Object.isFrozen(CPU_SCENE_PHASE_NAMES), true);
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    const start = profiler.beginSceneFrame(150, "sceneUpdate");
    assert.equal(start, 0);

    clock.advance(1);
    assert.equal(profiler.markScenePhase(150, "frameState"), true);
    clock.advance(2);
    assert.equal(profiler.markScenePhase(150, "rendererOverhead"), true);
    clock.advance(1);
    profiler.beginPass("globe");
    clock.advance(3);
    profiler.endPass("globe");
    clock.advance(2);
    assert.equal(profiler.markScenePhase(150, "primitiveTraversal"), true);
    clock.advance(1);
    assert.equal(profiler.markScenePhase(150, "rendererOverhead"), true);
    clock.advance(1);
    profiler.beginPass("globe");
    clock.advance(2);
    profiler.endPass("globe");
    clock.advance(3);

    assert.equal(profiler.recordSceneFrameCpu(150, 16, 16), true);
    const frame = profiler.getStats().lastFrame;
    assert.deepEqual(frame.passMs, { globe: 5 });
    assert.equal(frame.profiledPassMs, 5);
    assert.equal(frame.phaseMs.sceneUpdate, 1);
    assert.equal(frame.phaseMs.frameState, 2);
    assert.equal(frame.phaseMs.rendererOverhead, 7);
    assert.equal(frame.phaseMs.primitiveTraversal, 1);
    assert.equal(frame.phaseTotalMs, 11);
    assert.equal(frame.unaccountedMs, 11);
    assert.equal(frame.unattributedMs, 0);
    assert.equal(frame.attributionOverlapMs, 0);
    assert.equal(frame.attributionValid, true);
    assert.equal(frame.valid, true);
    assert.equal(
      frame.totalMs + frame.attributionOverlapMs,
      frame.profiledPassMs + frame.phaseTotalMs + frame.unattributedMs,
    );
    assert.equal(
      frame.unaccountedMs + frame.attributionOverlapMs,
      frame.phaseTotalMs + frame.unattributedMs + frame.overlapMs,
    );
    assert.equal(Object.isFrozen(frame.phaseMs), true);
    assert.deepEqual(Object.keys(frame.phaseMs), [
      "sceneUpdate",
      "frameState",
      "contextBegin",
      "sceneEnvironmentUpdate",
      "visibilityCommandPrep",
      "primitiveTraversal",
      "computeShadows",
      "rendererOverhead",
      "frameFinalize",
      "contextEndSubmit",
      "afterRenderCreditTrace",
    ]);
  });
});

test("phase markers are clock-free without an attributed normal token", () => {
  withDeterministicClock((clock) => {
    const disabled = new WebGPUCpuPassProfiler();
    assert.equal(disabled.beginSceneFrame(1, "sceneUpdate"), undefined);
    assert.equal(disabled.markScenePhase(1, "frameState"), false);
    assert.equal(clock.calls(), 0);

    const enabled = new WebGPUCpuPassProfiler(true);
    assert.equal(enabled.markScenePhase(1, "frameState"), false);
    enabled.beginFrame();
    assert.equal(enabled.markScenePhase(1, "frameState"), false);
    enabled.endFrame();
    assert.equal(clock.calls(), 0);
  });
});

test("an invalid runtime phase name fails closed before reading the clock", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    assert.equal(profiler.beginSceneFrame(153, "sceneUpdate"), 0);
    clock.advance(1);
    const callsBeforeInvalidMarker = clock.calls();
    assert.equal(profiler.markScenePhase(153, "not-a-scene-phase"), false);
    assert.equal(clock.calls(), callsBeforeInvalidMarker);
    assert.equal(profiler.recordSceneFrameCpu(153, 1, 1), false);
    assert.equal(profiler.getStats().lastFrame, null);
  });
});

test("shared phase boundaries telescope at large absolute clock values", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    clock.set(2 ** 42 - 0.5);
    const start = profiler.beginSceneFrame(152, "sceneUpdate");
    clock.advance(0.25);
    profiler.markScenePhase(152, "frameState");
    clock.advance(0.5);
    profiler.beginPass("opaque");
    clock.advance(0.75);
    profiler.endPass("opaque");
    clock.advance(0.125);
    profiler.markScenePhase(152, "afterRenderCreditTrace");
    clock.advance(0.375);
    const end = clock.now();

    assert.equal(end - start, 2);
    assert.equal(profiler.recordSceneFrameCpu(152, end - start, end), true);
    const frame = profiler.getStats().lastFrame;
    assert.equal(frame.profiledPassMs, 0.75);
    assert.equal(frame.phaseTotalMs, 1.25);
    assert.equal(frame.unattributedMs, 0);
    assert.equal(frame.attributionOverlapMs, 0);
    assert.equal(frame.attributionValid, true);
  });
});

test("attributed frames fail closed on overlapping passes and phase switches", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    profiler.beginSceneFrame(151, "sceneUpdate");
    clock.advance(1);
    profiler.beginPass("outer");
    profiler.beginPass("nested");
    assert.equal(profiler.markScenePhase(151, "frameState"), false);
    clock.advance(1);
    profiler.endPass("outer");
    assert.equal(profiler.recordSceneFrameCpu(151, 2, 2), false);
    assert.equal(profiler.getStats().lastFrame, null);
  });
});

test("empty render and isolated pick obey normal-frame boundaries", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    profiler.beginFrame(200);

    profiler.beginFrame();
    profiler.beginPass("pick");
    clock.advance(2);
    profiler.endPass("pick");
    profiler.endFrame();

    assert.equal(profiler.getStats().lastFrame, null);
    assert.equal(profiler.recordSceneFrameCpu(200, 7), true);
    const profile = profiler.getStats();
    assert.deepEqual(profile.lastFrame.passMs, {});
    assert.equal(profile.lastFrame.profiledPassMs, 0);
    assert.equal(profile.lastFrame.unaccountedMs, 7);
    assert.equal(profile.frameAccounting.samples, 1);
    assert.equal(profile.passes.pick.lastMs, 2);
  });
});

test("an isolated pick stays outside an attributed normal pass ledger", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    const start = profiler.beginSceneFrame(201, "sceneUpdate");
    clock.advance(1);
    assert.equal(profiler.markScenePhase(201, "afterRenderCreditTrace"), true);
    clock.advance(1);

    profiler.beginFrame();
    profiler.beginPass("pick");
    clock.advance(3);
    profiler.endPass("pick");
    profiler.endFrame();

    clock.advance(2);
    const end = clock.now();
    assert.equal(profiler.recordSceneFrameCpu(201, end - start, end), true);

    const profile = profiler.getStats();
    const frame = profile.lastFrame;
    assert.deepEqual(frame.passMs, {});
    assert.equal(frame.profiledPassMs, 0);
    assert.equal(frame.phaseMs.sceneUpdate, 1);
    assert.equal(frame.phaseMs.afterRenderCreditTrace, 6);
    assert.equal(frame.phaseTotalMs, 7);
    assert.equal(frame.unattributedMs, 0);
    assert.equal(frame.attributionValid, true);
    assert.equal(profile.passes.pick.lastMs, 3);
    assert.equal(profile.frameCount, 2);
  });
});

test("zero-total zero-pass coverage is complete and valid", () => {
  const profiler = new WebGPUCpuPassProfiler(true);
  profiler.beginFrame(201);
  assert.equal(profiler.recordSceneFrameCpu(201, 0), true);
  const frame = profiler.getStats().lastFrame;
  assert.equal(frame.totalMs, 0);
  assert.equal(frame.profiledPassMs, 0);
  assert.equal(frame.unaccountedMs, 0);
  assert.equal(frame.overlapMs, 0);
  assert.equal(frame.coverageRatio, 1);
  assert.equal(frame.valid, true);
});

test("mismatched and canceled Scene tokens never publish partial frames", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    profiler.beginFrame(300);
    profiler.beginPass("globe");
    clock.advance(3);
    profiler.endPass("globe");
    assert.equal(profiler.recordSceneFrameCpu(301, 8), false);
    assert.equal(profiler.getStats().lastFrame, null);

    profiler.beginFrame(301);
    profiler.beginPass("opaque");
    clock.advance(4);
    profiler.endPass("opaque");
    assert.equal(profiler.cancelSceneFrame(301), true);
    assert.equal(profiler.recordSceneFrameCpu(301, 9), false);
    assert.equal(profiler.getStats().frameAccounting, null);
  });
});

test("open passes and overwritten nested tokens fail closed", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    profiler.beginFrame(400);
    profiler.beginPass("open");
    clock.advance(2);
    assert.equal(profiler.recordSceneFrameCpu(400, 8), false);
    assert.equal(profiler.getStats().lastFrame, null);

    profiler.beginFrame(401);
    profiler.beginPass("outer");
    clock.advance(2);
    profiler.endPass("outer");
    profiler.beginFrame(402);
    profiler.beginPass("inner");
    clock.advance(3);
    profiler.endPass("inner");
    assert.equal(profiler.recordSceneFrameCpu(402, 7), true);
    assert.equal(profiler.recordSceneFrameCpu(401, 9), false);
    const profile = profiler.getStats();
    assert.equal(profile.frameAccounting.totalFrames, 1);
    assert.deepEqual(profile.lastFrame.passMs, { inner: 3 });
    assert.equal(profile.passes.outer, undefined);
  });
});

test("an invalid individual bucket cannot hide inside a valid aggregate", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    clock.advance(10);
    profiler.beginFrame(403);
    profiler.beginPass("negative");
    clock.advance(-5);
    profiler.endPass("negative");
    profiler.beginPass("positive");
    clock.advance(15);
    profiler.endPass("positive");
    assert.equal(profiler.recordSceneFrameCpu(403, 30), false);
    assert.equal(profiler.getStats().lastFrame, null);
    assert.equal(profiler.getStats().frameCount, 0);
  });
});

test("NaN and Infinity pass buckets are rejected", () => {
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    profiler.beginFrame(404);
    profiler.beginPass("nan");
    clock.advance(Number.NaN);
    profiler.endPass("nan");
    assert.equal(profiler.recordSceneFrameCpu(404, 10), false);
  });

  // Use direct clock replacement for Infinity because advancing from NaN is
  // intentionally irreversible inside the preceding isolated clock scope.
  withDeterministicClock((clock) => {
    const profiler = new WebGPUCpuPassProfiler(true);
    profiler.beginFrame(405);
    profiler.beginPass("infinity");
    clock.advance(Number.POSITIVE_INFINITY);
    profiler.endPass("infinity");
    assert.equal(profiler.recordSceneFrameCpu(405, 10), false);
    assert.equal(profiler.getStats().lastFrame, null);
  });
});

test("total Scene count remains monotonic beyond the rolling window", () => {
  const profiler = new WebGPUCpuPassProfiler(true);
  for (let frameNumber = 1; frameNumber <= 61; frameNumber++) {
    profiler.beginFrame(frameNumber);
    assert.equal(profiler.recordSceneFrameCpu(frameNumber, 1), true);
  }
  const profile = profiler.getStats();
  assert.equal(profile.frameAccounting.totalFrames, 61);
  assert.equal(profile.frameAccounting.samples, 60);
  assert.equal(profile.lastFrame.sequence, 61);
  assert.equal(profile.lastFrame.sceneFrameNumber, 61);
});

test("Scene wrapper owns one fail-closed public render boundary", () => {
  const sceneSource = readFileSync(
    "packages/engine/Source/Scene/Scene.js",
    "utf8",
  );
  const renderStart = sceneSource.indexOf("  render(time) {");
  const clockGate = sceneSource.indexOf(
    "cpuFrameRenderer?.cpuPassProfilingEnabled === true",
    renderStart,
  );
  const guardRead = sceneSource.indexOf(
    "cpuAccountingSceneGuard.get(this)",
    renderStart,
  );
  const wrapperCall = sceneSource.indexOf(
    "return renderSceneWithCpuAccounting(this, time, cpuFrameRenderer)",
    renderStart,
  );
  const preUpdate = sceneSource.indexOf(
    "this._preUpdate.raiseEvent(this, time)",
    renderStart,
  );
  const helperStart = sceneSource.indexOf(
    "function renderSceneWithCpuAccounting(scene, time, renderer)",
  );
  const baseCapture = sceneSource.indexOf(
    "const renderSceneForCpuAccounting = Scene.prototype.render",
  );
  const begin = sceneSource.indexOf(
    "renderer.beginCpuSceneFrame(",
    helperStart,
  );
  const listener = sceneSource.indexOf(
    "scene._renderError.addEventListener",
    helperStart,
  );
  const recursiveRender = sceneSource.indexOf(
    "renderSceneForCpuAccounting.call(scene, time)",
    helperStart,
  );
  const record = sceneSource.indexOf(
    "renderer.recordSceneFrameCpu(",
    helperStart,
  );
  const cancel = sceneSource.indexOf(
    "renderer.cancelCpuSceneFrame(expectedFrameNumber)",
    helperStart,
  );
  const guardDeactivate = sceneSource.indexOf(
    "accountingState.active = false",
    helperStart,
  );

  assert.ok(renderStart >= 0);
  assert.ok(clockGate > renderStart && clockGate < preUpdate);
  assert.ok(guardRead > renderStart && guardRead < clockGate);
  assert.ok(wrapperCall > clockGate && wrapperCall < preUpdate);
  assert.ok(baseCapture > renderStart && baseCapture < helperStart);
  assert.ok(listener > helperStart && listener < begin);
  assert.ok(begin > helperStart && begin < recursiveRender);
  assert.ok(record > recursiveRender);
  assert.ok(cancel > record);
  assert.ok(guardDeactivate > cancel);
  assert.doesNotMatch(
    sceneSource.slice(helperStart, guardDeactivate),
    /scene\.render\(time\)|Scene\.prototype\.render\.call/,
  );
  assert.match(
    sceneSource.slice(helperStart, guardDeactivate),
    /beginCpuSceneFrame\([\s\S]*"sceneUpdate"[\s\S]*renderSceneForCpuAccounting\.call\(scene, time\)[\s\S]*recordSceneFrameCpu\(/,
  );
  assert.match(
    sceneSource.slice(helperStart, guardDeactivate),
    /!renderErrorRaised[\s\S]*!accountingState\.reentered[\s\S]*frameState\.newFrame === true[\s\S]*frameState\.frameNumber === expectedFrameNumber[\s\S]*scene\._alternateSceneRenderer === renderer[\s\S]*renderer\.cpuPassProfilingEnabled === true/,
  );
  assert.match(
    sceneSource.slice(renderStart, preUpdate),
    /cpuAccountingSceneGuard\.get\(this\)[\s\S]*baseEntryExpected[\s\S]*reentered = true[\s\S]*cpuPassProfilingEnabled === true/,
  );
});
