// C11-140 — NEW-GPU-TIMESTAMP-UNIQUE-SAMPLE-ACCOUNTING.
// @purpose Pins the GPU timestamp profiler's union-fold frame coverage (overlap surfaced, never double-counted) and its no-silent-loss attempt ledger.
// @status ACTIVE
//
// Prerequisite-grade tooling: every later C11 GPU-lane perf claim is only as
// falsifiable as the timer it cites. Two invariants have to be provable without
// an adapter, and both are proved here:
//
//   1. UNIQUE SAMPLES — the frame span is divided into "covered by a named
//      pass" and "unprofiled remainder", with every GPU nanosecond in exactly
//      one of the two. Summing pass durations does not do that: overlapping
//      passes contribute their intersection twice. The profiler used to divide
//      that SUM by the frame span and clamp the ratio to 1, which reports 100%
//      coverage for a frame that was measured wrong. The union fold replaces
//      the clamp, and the excess is surfaced as `overlapMs`.
//   2. NO SILENT LOSS — every profiling attempt reaches exactly one terminal
//      outcome (sampled / skipped / empty / failed / lost / pending), and those
//      sum to the attempt count. The readback tail is drained rather than
//      dropped, and what a bounded drain cannot recover is reported.
//
// Both the pure fold and the profiler that consumes it are exercised: the
// profiler is transpiled and driven against a fake GPUDevice, so the ledger is
// checked on the real state machine, not on a re-implementation of it.
//
// Run: node --test Tools/visual-regression/gpu-timestamp-unique-sample-accounting.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);

const toDataUrl = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

/**
 * Transpiles one engine TS module to a data: URL. A data: module cannot
 * resolve relative specifiers, so any inter-module import is rewritten to the
 * already-transpiled dependency's URL.
 */
async function transpileEngineModule(fileName, rewrites = {}) {
  let source = await readFile(resolve(engineWebGPU, fileName), "utf8");
  for (const [specifier, url] of Object.entries(rewrites)) {
    source = source.replaceAll(specifier, url);
  }
  const { code } = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  return toDataUrl(code);
}

const accountingUrl = await transpileEngineModule(
  "WebGPUTimestampAccounting.ts",
);
const accounting = await import(accountingUrl);
const { mergeTimedIntervals, summarizeFrameCoverage, balanceSampleLedger } =
  accounting;

// The profiler reaches for WebGPU's ambient constant objects at construction
// and readback time; Node has no WebGPU globals, so stand them in.
globalThis.GPUBufferUsage ??= {
  QUERY_RESOLVE: 0x0200,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  MAP_READ: 0x0001,
};
globalThis.GPUMapMode ??= { READ: 0x0001, WRITE: 0x0002 };

const MS = 1_000_000; // nanoseconds per millisecond

const pass = (name, beginMs, endMs) => ({
  name,
  beginNs: beginMs * MS,
  endNs: endMs * MS,
});

// ───────────────────────────── the pure fold ─────────────────────────────

test("disjoint passes: the union equals the sum, no overlap", () => {
  const coverage = summarizeFrameCoverage([
    pass("terrain", 0, 2),
    pass("models", 3, 4),
  ]);
  assert.equal(coverage.frameSpanMs, 4);
  assert.equal(coverage.coveredMs, 3);
  assert.equal(coverage.summedPassMs, 3);
  assert.equal(coverage.overlapMs, 0);
  assert.equal(coverage.unprofiledMs, 1);
  assert.equal(coverage.coverageRatio, 0.75);
  assert.equal(coverage.unprofiledRatio, 0.25);
  assert.equal(coverage.balanced, true);
});

test("THE DOUBLE-COUNT: overlapping passes cannot inflate coverage past the span", () => {
  // Two 3 ms passes overlapping by 2 ms inside a 4 ms span. The naive sum is
  // 6 ms — 150% of the span — which the old clamp reported as 100% coverage
  // and a zero remainder. The union says 4 ms covered, 0 unprofiled, and names
  // the 2 ms of double-counting.
  const coverage = summarizeFrameCoverage([
    pass("compute", 0, 3),
    pass("render", 1, 4),
  ]);
  assert.equal(coverage.frameSpanMs, 4);
  assert.equal(coverage.summedPassMs, 6);
  assert.equal(coverage.coveredMs, 4);
  assert.equal(coverage.overlapMs, 2);
  assert.equal(coverage.coverageRatio, 1);
  assert.equal(coverage.unprofiledMs, 0);
  assert.equal(coverage.balanced, true);

  // A pass fully nested in another contributes nothing new to the union.
  const nested = summarizeFrameCoverage([
    pass("outer", 0, 10),
    pass("inner", 2, 4),
  ]);
  assert.equal(nested.coveredMs, 10);
  assert.equal(nested.summedPassMs, 12);
  assert.equal(nested.overlapMs, 2);
  assert.equal(nested.coverageRatio, 1);
});

test("covered + unprofiled reconstructs the frame span (no gap, no overcount)", () => {
  const cases = [
    [pass("a", 0, 1)],
    [pass("a", 0, 1), pass("b", 5, 6)],
    [pass("a", 0, 4), pass("b", 1, 2), pass("c", 3, 9)],
    [pass("a", 2, 2)], // zero-length
  ];
  for (const samples of cases) {
    const coverage = summarizeFrameCoverage(samples);
    assert.equal(
      coverage.balanced,
      true,
      `covered+unprofiled must equal the span for ${JSON.stringify(samples)}`,
    );
    assert.ok(coverage.coveredMs <= coverage.frameSpanMs + 1e-9);
    assert.ok(coverage.unprofiledMs >= -1e-9);
    if (coverage.coverageRatio !== null) {
      assert.ok(
        Math.abs(coverage.coverageRatio + coverage.unprofiledRatio - 1) < 1e-9,
        "coverageRatio + unprofiledRatio must be 1",
      );
      assert.ok(coverage.coverageRatio <= 1 + 1e-9);
    }
  }
});

test("degenerate and inverted inputs resolve honestly, not as NaN or negatives", () => {
  const empty = summarizeFrameCoverage([]);
  assert.equal(empty.frameSpanMs, 0);
  assert.equal(empty.coverageRatio, null);
  assert.equal(empty.unprofiledRatio, null);
  assert.equal(empty.balanced, true);
  assert.equal(empty.sampleCount, 0);

  // A driver that reports end < begin must be counted, not folded in.
  const inverted = summarizeFrameCoverage([
    pass("good", 0, 2),
    pass("bad", 5, 4),
  ]);
  assert.equal(inverted.invertedSampleCount, 1);
  assert.equal(inverted.sampleCount, 1);
  assert.equal(inverted.coveredMs, 2);
  assert.ok(inverted.unprofiledMs >= 0);
});

test("interval merge is order-independent and coalesces touching spans", () => {
  assert.deepEqual(mergeTimedIntervals([pass("b", 3, 4), pass("a", 0, 2)]), [
    [0, 2 * MS],
    [3 * MS, 4 * MS],
  ]);
  // Touching at a shared instant is one span, not two.
  assert.deepEqual(mergeTimedIntervals([pass("a", 0, 2), pass("b", 2, 4)]), [
    [0, 4 * MS],
  ]);
  // Zero-length samples never widen the union.
  assert.deepEqual(mergeTimedIntervals([pass("a", 1, 1)]), []);
});

test("the sample ledger balances only when every attempt has an outcome", () => {
  const closed = balanceSampleLedger({
    attempted: 10,
    sampled: 6,
    skipped: 2,
    empty: 1,
    failed: 0,
    lost: 0,
    pending: 1,
  });
  assert.equal(closed.balanced, true);
  assert.equal(closed.unaccounted, 0);

  // Negative control: a dropped tail frame must NOT balance.
  const leaky = balanceSampleLedger({
    attempted: 10,
    sampled: 6,
    skipped: 2,
    empty: 1,
    failed: 0,
    lost: 0,
    pending: 0,
  });
  assert.equal(leaky.balanced, false);
  assert.equal(leaky.unaccounted, 1);
});

// ───────────────── the profiler on a fake GPUDevice ─────────────────

class FakeBuffer {
  constructor(descriptor) {
    this.label = descriptor.label;
    this.mapState = "unmapped";
    this.array = new BigUint64Array(descriptor.size / 8);
    this.destroyed = false;
    this._resolvers = [];
  }

  mapAsync() {
    this.mapState = "pending";
    return new Promise((resolveMap) => {
      this._resolvers.push(() => {
        this.mapState = "mapped";
        resolveMap();
      });
    });
  }

  /** Completes any outstanding mapAsync — the test's stand-in for the GPU. */
  settle() {
    const resolvers = this._resolvers;
    this._resolvers = [];
    for (const complete of resolvers) {
      complete();
    }
  }

  getMappedRange() {
    return this.array.buffer;
  }

  unmap() {
    this.mapState = "unmapped";
  }

  destroy() {
    this.destroyed = true;
  }
}

function makeFakeDevice() {
  const buffers = [];
  return {
    buffers,
    features: { has: (feature) => feature === "timestamp-query" },
    createQuerySet: (descriptor) => ({ ...descriptor, destroy() {} }),
    createBuffer: (descriptor) => {
      const buffer = new FakeBuffer(descriptor);
      buffers.push(buffer);
      return buffer;
    },
  };
}

const fakeEncoder = {
  resolveQuerySet() {},
  copyBufferToBuffer() {},
};

/** Readback buffer for triple-buffered frame state `index`. */
const readbackBufferFor = (device, index) => device.buffers[index * 2 + 1];

/** Lets every already-resolved promise chain run to completion. */
const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
};

const { WebGPUTimestampProfiler } = await import(
  await transpileEngineModule("WebGPUTimestampProfiler.ts", {
    "./WebGPUTimestampAccounting.js": accountingUrl,
  })
);

/**
 * Profiles one frame end-to-end, writing `samples` (in ms, relative to an
 * arbitrary large device origin) into the slot's readback buffer.
 */
async function profileFrame(profiler, device, slotIndex, samples) {
  const ORIGIN_NS = 1_234_567_890_123n; // absolute device timestamps are large
  profiler.beginFrame();
  const writes = samples.map(({ name }) =>
    profiler.getPassTimestampWrites(name),
  );
  profiler.endFrame(fakeEncoder);

  const buffer = readbackBufferFor(device, slotIndex);
  samples.forEach((sample, index) => {
    const write = writes[index];
    if (!write) {
      return;
    }
    buffer.array[write.beginningOfPassWriteIndex] =
      ORIGIN_NS + BigInt(Math.round(sample.beginMs * MS));
    buffer.array[write.endOfPassWriteIndex] =
      ORIGIN_NS + BigInt(Math.round(sample.endMs * MS));
  });

  profiler.afterSubmit();
  buffer.settle();
  await flushMicrotasks();
  return writes;
}

test("profiler: the ledger closes across sampled, empty and skipped frames", async () => {
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true);
  assert.equal(profiler.enabled, true);

  // Slot 0: two overlapping passes — the double-count case, end to end.
  await profileFrame(profiler, device, 0, [
    { name: "compute", beginMs: 0, endMs: 3 },
    { name: "render", beginMs: 1, endMs: 4 },
  ]);

  let results = profiler.getResults();
  assert.equal(results.frameCount, 1);
  assert.equal(results.frameMs, 4);
  assert.equal(results.profiledPassMs, 6, "naive sum still reported");
  assert.equal(results.coveredMs, 4, "union is the unique-sample measure");
  assert.equal(results.overlapMs, 2);
  assert.equal(results.overlappingFrameCount, 1);
  assert.equal(results.coverageRatio, 1);
  assert.equal(results.unprofiledRatio, 0);
  assert.equal(results.coverageBalanced, true);
  assert.equal(results.sampleLedgerBalanced, true);
  assert.equal(results.unaccountedSampleCount, 0);

  // Slot 1: an armed frame with no timed pass at all.
  profiler.beginFrame();
  profiler.endFrame(fakeEncoder);
  results = profiler.getResults();
  assert.equal(results.emptyFrameCount, 1);
  assert.equal(results.attemptedFrameCount, 2);
  assert.equal(results.sampleLedgerBalanced, true);

  // Slot 2: a frame whose readback never settles, so slot 2 stays pending and
  // the next rotation onto it is a truthful skip.
  profiler.beginFrame();
  const held = profiler.getPassTimestampWrites("held");
  assert.ok(held, "slot 2 must be available");
  profiler.endFrame(fakeEncoder);
  profiler.afterSubmit();
  await flushMicrotasks();

  results = profiler.getResults();
  assert.equal(results.pendingReadbackCount, 1);
  assert.equal(results.sampleLedgerBalanced, true);
  assert.equal(results.unaccountedSampleCount, 0);
});

test("profiler: a busy readback slot is a counted skip, never a silent drop", async () => {
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true);

  // Fill all three slots with readbacks that never settle.
  for (let slot = 0; slot < 3; slot++) {
    profiler.beginFrame();
    assert.ok(profiler.getPassTimestampWrites(`pass${slot}`));
    profiler.endFrame(fakeEncoder);
    profiler.afterSubmit();
  }
  await flushMicrotasks();

  // The fourth frame rotates back onto slot 0, which is still in flight.
  profiler.beginFrame();
  assert.equal(
    profiler.getPassTimestampWrites("starved"),
    undefined,
    "an unavailable slot must not hand out query indices",
  );
  profiler.endFrame(fakeEncoder);

  const results = profiler.getResults();
  assert.equal(results.attemptedFrameCount, 4);
  assert.equal(results.readbackSkipCount, 1);
  assert.equal(results.pendingReadbackCount, 3);
  assert.equal(results.frameCount, 0);
  assert.equal(results.sampleLedgerBalanced, true);
  assert.equal(results.unaccountedSampleCount, 0);
});

test("profiler: drain recovers the tail, and reports what it cannot", async () => {
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true);

  // A frame whose readback is in flight when the capture stops. Without a
  // drain this sample is simply gone from the report.
  profiler.beginFrame();
  const writes = profiler.getPassTimestampWrites("tail");
  profiler.endFrame(fakeEncoder);
  const buffer = readbackBufferFor(device, 0);
  buffer.array[writes.beginningOfPassWriteIndex] = 1000n;
  buffer.array[writes.endOfPassWriteIndex] = 1000n + BigInt(2 * MS);
  profiler.afterSubmit();

  assert.equal(profiler.getResults().frameCount, 0, "not yet readable");

  const drainPromise = profiler.drainPendingReadbacks(1000);
  buffer.settle();
  const drain = await drainPromise;
  assert.equal(drain.drained, 1);
  assert.equal(drain.undrained, 0);
  assert.equal(drain.abandoned, 0);
  assert.equal(drain.timedOut, false);

  const drained = profiler.getResults();
  assert.equal(drained.frameCount, 1, "the tail frame is now reported");
  assert.equal(drained.frameMs, 2);
  assert.equal(drained.pendingReadbackCount, 0);
  assert.equal(drained.sampleLedgerBalanced, true);

  // A readback that will never complete must bound the drain, not hang it,
  // and the unrecovered sample must be reported rather than assumed.
  profiler.beginFrame();
  assert.ok(profiler.getPassTimestampWrites("stuck"));
  profiler.endFrame(fakeEncoder);
  profiler.afterSubmit();
  const stuck = await profiler.drainPendingReadbacks(10);
  assert.equal(stuck.timedOut, true);
  assert.equal(stuck.undrained, 1);
  assert.equal(profiler.getResults().sampleLedgerBalanced, true);
});

test("profiler: submissions never handed to afterSubmit are lost, and counted", async () => {
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true);

  profiler.beginFrame();
  assert.ok(profiler.getPassTimestampWrites("orphan"));
  profiler.endFrame(fakeEncoder);
  // No afterSubmit(): no readback was ever started for this submission.

  const drain = await profiler.drainPendingReadbacks(10);
  assert.equal(drain.abandoned, 1);

  const results = profiler.getResults();
  assert.equal(results.lostSampleCount, 1);
  assert.equal(results.frameCount, 0);
  assert.equal(results.sampleLedgerBalanced, true);
  assert.equal(results.unaccountedSampleCount, 0);

  // Slot 0 must be reusable afterwards. Frame states rotate, so it takes two
  // more frames to come back around to it — a poisoned slot would turn that
  // rotation, and every later one, into a permanent skip.
  for (const slot of [1, 2, 0]) {
    await profileFrame(profiler, device, slot, [
      { name: "after", beginMs: 0, endMs: 1 },
    ]);
  }
  const reused = profiler.getResults();
  assert.equal(reused.frameCount, 3, "slot 0 must accept work again");
  assert.equal(reused.readbackSkipCount, 0);
  assert.equal(reused.sampleLedgerBalanced, true);
});

test("profiler: a disabled profiler still reports a balanced, zeroed ledger", () => {
  const profiler = new WebGPUTimestampProfiler(
    { features: { has: () => false } },
    false,
  );
  const results = profiler.getResults();
  assert.equal(results.enabled, false);
  assert.equal(results.coverageRatio, null);
  assert.equal(results.sampleLedgerBalanced, true);
  assert.equal(results.unaccountedSampleCount, 0);
});

test("the profiler routes coverage through the shared fold, and the clamp is gone", async () => {
  const source = await readFile(
    resolve(engineWebGPU, "WebGPUTimestampProfiler.ts"),
    "utf8",
  );
  assert.match(source, /summarizeFrameCoverage\(samples\)/);
  assert.match(source, /balanceSampleLedger\(/);
  assert.doesNotMatch(
    source,
    /Math\.min\(1,\s*profiledPassStats/,
    "the clamped sum/span ratio must not come back — it hides double counting",
  );
});

test("the adapter certification probe is offline and fails closed when timestamps are unavailable", async () => {
  const source = await readFile(
    resolve(directory, "probe-gpu-timestamp-profiler.mjs"),
    "utf8",
  );
  assert.match(source, /renderer=webgpu&offline=true/);
  assert.match(source, /const VIEWER_URL\s*=/);
  assert.match(source, /new URL\(VIEWER_URL\)\.origin/);
  assert.doesNotMatch(
    source,
    /const URL\s*=/,
    "the viewer URL must not shadow Node's global URL constructor",
  );
  assert.match(source, /externalRequests\.push\(request\.url\(\)\)/);
  assert.match(
    source,
    /failures\.push\(`\$\{consoleErrors\.length\} console error/,
  );
  assert.match(source, /if \(!result\.featureAvailable\) \{/);
  assert.match(source, /process\.exitCode = 3/);
  assert.doesNotMatch(
    source,
    /certified:\s*failures\.length === 0\s*,/,
    "an unavailable timestamp feature must never be rounded into certification",
  );
});
