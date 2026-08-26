// gpu-timestamp-readback-ring-depth.spec.mjs — the readback ring must be deep
// enough for the workload it is measuring, and must say so when it is not.
// @purpose Pins the GPU timestamp profiler's readback-ring depth behaviour: a workload at the measured worst-case latency retains every sample at a sufficient depth, and a ring that saturates at any depth still reports the loss instead of averaging past it.
// @status ACTIVE
//
// WHAT THIS IS ABOUT. The profiler rotates one slot per profiled frame, and a
// slot's `mapAsync` holds it until the GPU finishes that frame's submission and
// the map callback is delivered. A slot still held when the ring returns to it
// costs the whole frame its timing — `beginFrame` leaves the frame unarmed, its
// passes run with no `timestampWrites` at all, and `readbackSkipCount` records
// it. The depth the ring needs is therefore the readback latency expressed in
// profiled frames, and nothing about "triple buffering" makes three the right
// number for a workload whose per-frame GPU cost approaches the frame period.
//
// WHAT THE MEASUREMENT SHOWED. An eight-pair interleaved refresh-cost lane
// submitted 280 environment refreshes on WebGPU and retained 196, a 30% loss,
// against 1 of 82 on its eclipse-off control. Every counter that names a
// post-capture failure read zero — no lost samples, no failed readbacks, no
// dropped passes, a balanced ledger in all sixteen segments — so nothing was
// mishandled after capture. The frames were never armed: 182 skips against 280
// refreshes. The loss is also a strict SUFFIX of each segment's refresh
// sequence, with zero interior gaps across 280 samples, which is what a ring
// that falls behind and does not recover looks like rather than what random
// contention looks like.
//
// WHERE THE NUMBERS BELOW COME FROM. The ring visits a slot once every `B`
// frames and a capture holds it for `L` frames, so the attempts consumed per
// capture are `ceil(L / B)` and an observed capture rate `r` brackets the
// latency at `B / r` from above. The worst segment sampled 44 of 100 attempts
// at `B = 3`, giving `L <= 6.8` frames; the next worst gave 5.7. WORST_LATENCY
// is that bound rounded up, and SUFFICIENT_DEPTH adds a frame of margin because
// that segment straddled two device rate regimes. The cadence and pass count
// mirror the same segment: 57 refreshes per 100 frames, four timed compute
// passes each, and — as in the lane — every frame is timed, so every frame
// occupies a slot.
//
// WHAT IS PINNED AND WHAT IS NOT. The assertions are about retention and
// reporting, not about any particular depth. The sweep derives the shallowest
// sufficient depth from the simulated latency instead of naming a constant, so
// changing the default cannot make it pass vacuously. Raising the depth is
// also required NOT to silence saturation: a ring saturated beyond what its
// depth covers must still report it, because a quiet biased mean is worse than
// a loud missing one.
//
// The profiler is transpiled and driven on its real state machine against a
// fake GPUDevice whose readbacks settle on a controlled schedule. Nothing here
// reads the source as text — a source-text assertion certifies text, not
// liveness, which is why the mutation group makes the real code inert and
// requires these tests to go red.
//
// Run: node --test Tools/visual-regression/gpu-timestamp-readback-ring-depth.spec.mjs

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
 * Transpiles TypeScript source text to an importable data: URL. A data: module
 * cannot resolve relative specifiers, so the accounting import is rewritten to
 * the already-transpiled dependency.
 *
 * @param {string} source TypeScript source text.
 * @param {Record<string,string>} rewrites Specifier substitutions.
 * @returns {Promise<string>} The data: URL.
 */
async function transpile(source, rewrites = {}) {
  let text = source;
  for (const [specifier, url] of Object.entries(rewrites)) {
    text = text.replaceAll(specifier, url);
  }
  const { code } = await transform(text, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  return toDataUrl(code);
}

const accountingUrl = await transpile(
  await readFile(resolve(engineWebGPU, "WebGPUTimestampAccounting.ts"), "utf8"),
);
const PROFILER_SOURCE = await readFile(
  resolve(engineWebGPU, "WebGPUTimestampProfiler.ts"),
  "utf8",
);

/**
 * Imports the profiler, optionally through a source mutation.
 *
 * @param {(source: string) => string} [mutate] Source rewrite.
 * @param {string} [label] Name used in the did-it-change assertion.
 * @returns {Promise<Function>} The profiler class.
 */
async function importProfiler(mutate, label) {
  let source = PROFILER_SOURCE;
  if (mutate) {
    source = mutate(PROFILER_SOURCE);
    assert.notEqual(
      source,
      PROFILER_SOURCE,
      `the ${label} mutation changed nothing — its anchor text has moved, so ` +
        `this mutation test would pass vacuously and the result it exists to ` +
        `falsify would be unfalsifiable`,
    );
  }
  const module = await import(
    await transpile(source, { "./WebGPUTimestampAccounting.js": accountingUrl })
  );
  return module.WebGPUTimestampProfiler;
}

// The profiler reaches for WebGPU's ambient constant objects at construction
// and readback time; Node has no WebGPU globals, so stand them in.
globalThis.GPUBufferUsage ??= {
  QUERY_RESOLVE: 0x0200,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  MAP_READ: 0x0001,
};
globalThis.GPUMapMode ??= { READ: 0x0001, WRITE: 0x0002 };

const WebGPUTimestampProfiler = await importProfiler();

// ───────────────────────── the measured workload ─────────────────────────

/** Frames in the modelled segment, matching the lane's segment length. */
const SEGMENT_FRAMES = 100;

/** Refreshes in the worst segment: 57 of its 100 frames submitted one. */
const REFRESHES_PER_SEGMENT = 57;

/** Timed compute passes the lane labels per environment refresh. */
const PASSES_PER_REFRESH = 4;

/**
 * Readback latency in profiled frames, from the worst measured segment: it
 * sampled 44 of 100 attempts through a three-slot ring, and `B / r` brackets
 * the latency at 6.8 frames from above.
 */
const WORST_LATENCY = 7;

/** The worst latency plus one frame, since that segment straddled two rates. */
const SUFFICIENT_DEPTH = 8;

/** The historical depth, which is still the default. */
const DEFAULT_DEPTH = 3;

/** Queries per slot: the profiler's 128-pass ceiling, begin and end each. */
const QUERIES_PER_SLOT = 256;

// ───────────────────── the profiler on a fake GPUDevice ─────────────────────

class FakeBuffer {
  constructor(descriptor) {
    this.label = descriptor.label;
    this.size = descriptor.size;
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

  /** Whether a readback is still in flight on this slot. */
  get pending() {
    return this._resolvers.length > 0;
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
  const querySets = [];
  return {
    buffers,
    querySets,
    features: { has: (feature) => feature === "timestamp-query" },
    createQuerySet: (descriptor) => {
      const querySet = { ...descriptor, destroyed: false };
      querySet.destroy = () => {
        querySet.destroyed = true;
      };
      querySets.push(querySet);
      return querySet;
    },
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

/** Lets every already-resolved promise chain run to completion. */
const flushMicrotasks = async () => {
  for (let i = 0; i < 16; i += 1) {
    await Promise.resolve();
  }
};

/**
 * Readback buffer for ring slot `index`. Each slot allocates its resolve buffer
 * first and its readback buffer second, in slot order.
 *
 * @param {object} device Fake device.
 * @param {number} index Slot index.
 * @returns {FakeBuffer} The slot's readback buffer.
 */
const readbackBufferFor = (device, index) => device.buffers[index * 2 + 1];

/** The engine source's own line terminator, so mutations anchor exactly. */
const NEWLINE = PROFILER_SOURCE.includes("\r\n") ? "\r\n" : "\n";

/** Absolute device timestamps are large; the profiler works relative to them. */
const ORIGIN_NS = 1_234_567_890_123n;
const NS_PER_MS = 1_000_000;

/** Spreads the segment's refreshes evenly, as the eclipse ramp submits them. */
const isRefreshFrame = (frame, refreshes, frames) =>
  Math.floor(((frame + 1) * refreshes) / frames) -
    Math.floor((frame * refreshes) / frames) >
  0;

/**
 * Drives one segment of the measured workload through a ring of a given depth
 * whose readbacks settle a fixed number of frames after they start.
 *
 * The ring advances one slot per profiled frame, so frame `f` uses slot
 * `f % depth`; that rotation is documented behaviour, which is what lets this
 * driver find the slot without reaching into the profiler's private state.
 *
 * @param {object} options Driver options.
 * @param {number} options.depth Ring depth.
 * @param {number} options.latencyFrames Frames a readback holds its slot.
 * @param {Function} [options.ProfilerClass] Profiler constructor to drive.
 * @param {number} [options.frames] Frames in the segment.
 * @param {number} [options.refreshes] Refresh-bearing frames in the segment.
 * @param {number} [options.passes] Timed passes per refresh.
 * @returns {Promise<object>} What the segment retained and what it reported.
 */
async function runSegment({
  depth,
  latencyFrames,
  ProfilerClass = WebGPUTimestampProfiler,
  frames = SEGMENT_FRAMES,
  refreshes = REFRESHES_PER_SEGMENT,
  passes = PASSES_PER_REFRESH,
}) {
  const device = makeFakeDevice();
  const profiler = new ProfilerClass(device, true, depth);
  const ringDepth = profiler.bufferCount;
  const settleAt = new Map();
  let submittedRefreshes = 0;
  let armedRefreshes = 0;
  let unarmedFrames = 0;

  for (let f = 0; f < frames; f += 1) {
    for (const buffer of settleAt.get(f) ?? []) {
      buffer.settle();
    }
    settleAt.delete(f);
    await flushMicrotasks();

    const buffer = readbackBufferFor(device, f % ringDepth);
    const refresh = isRefreshFrame(f, refreshes, frames);
    // Every frame carries at least one timed pass, exactly as the lane does:
    // the profiler is armed for the whole scene, not only for the refresh, so
    // every frame occupies a slot whether or not it refreshed.
    const passCount = refresh ? passes : 1;

    profiler.beginFrame();
    const writes = [];
    for (let p = 0; p < passCount; p += 1) {
      writes.push(profiler.getComputePassTimestampWrites(`pass${p}`));
    }
    const armed = writes[0] !== undefined;
    if (refresh) {
      submittedRefreshes += 1;
      if (armed) {
        armedRefreshes += 1;
      }
    }
    if (!armed) {
      unarmedFrames += 1;
    }
    profiler.endFrame(fakeEncoder);

    writes.forEach((write, index) => {
      if (!write) {
        return;
      }
      buffer.array[write.beginningOfPassWriteIndex] = ORIGIN_NS;
      buffer.array[write.endOfPassWriteIndex] =
        ORIGIN_NS + BigInt((index + 1) * NS_PER_MS);
    });

    profiler.afterSubmit();
    await flushMicrotasks();

    if (buffer.pending) {
      const due = f + latencyFrames;
      if (!settleAt.has(due)) {
        settleAt.set(due, []);
      }
      settleAt.get(due).push(buffer);
    }
  }

  // Settle the tail so the ledger is read on a quiesced ring rather than
  // mid-flight, where pending readbacks are legitimately still outstanding.
  for (const buffers of settleAt.values()) {
    for (const buffer of buffers) {
      buffer.settle();
    }
  }
  await flushMicrotasks();

  return {
    device,
    profiler,
    results: profiler.getResults(),
    submittedRefreshes,
    armedRefreshes,
    lostRefreshes: submittedRefreshes - armedRefreshes,
    unarmedFrames,
  };
}

/**
 * The shallowest ring depth that retains every refresh at a given latency.
 *
 * @param {number} latencyFrames Frames a readback holds its slot.
 * @param {number} [maxDepth] Depth ceiling to search up to.
 * @returns {Promise<number|null>} The depth, or null if none suffices.
 */
async function shallowestSufficientDepth(latencyFrames, maxDepth = 16) {
  for (let depth = 2; depth <= maxDepth; depth += 1) {
    const run = await runSegment({ depth, latencyFrames });
    if (run.lostRefreshes === 0 && run.results.readbackSkipCount === 0) {
      return depth;
    }
  }
  return null;
}

/**
 * Asserts the six terminal outcomes still add up to the attempts.
 *
 * @param {object} results Profiling results.
 * @param {string} context Message prefix.
 */
function assertLedgerClosed(results, context) {
  assert.equal(
    results.sampleLedgerBalanced,
    true,
    `${context}: every attempt must reach exactly one terminal outcome`,
  );
  assert.equal(
    results.unaccountedSampleCount,
    0,
    `${context}: an attempt with no outcome is a silently vanished sample`,
  );
}

// ─────────────────────────── the defect, reproduced ───────────────────────

test("at the default depth the measured workload loses samples — and says so", async () => {
  const run = await runSegment({
    depth: DEFAULT_DEPTH,
    latencyFrames: WORST_LATENCY,
  });

  assert.equal(run.submittedRefreshes, REFRESHES_PER_SEGMENT);
  assert.ok(
    run.lostRefreshes > 0,
    `a ${DEFAULT_DEPTH}-slot ring cannot cover a ${WORST_LATENCY}-frame ` +
      `readback latency, so refreshes must go unarmed; none did, which means ` +
      `this driver is not reproducing the measured condition`,
  );

  // The loss is REPORTED, not absorbed. These must hold together: a counter
  // that moves while the ledger silently rebalances is the same defect
  // wearing a number.
  assert.ok(
    run.results.readbackSkipCount > 0,
    "an unarmed frame must be counted as a skip",
  );
  assert.equal(
    run.results.readbackSkipCount,
    run.unarmedFrames,
    "the skip counter must equal the frames the driver watched go unarmed, " +
      "not merely be non-zero",
  );
  assert.equal(
    run.results.ringSaturated,
    true,
    "a ring that dropped frames must report itself saturated, so a consumer " +
      "cannot average over the survivors without seeing that they are one",
  );
  assertLedgerClosed(run.results, "default depth");

  // Nothing was mishandled AFTER capture, which is what the measured artifact
  // also showed: those frames were never armed in the first place.
  assert.equal(run.results.lostSampleCount, 0);
  assert.equal(run.results.failedReadbackCount, 0);
  assert.equal(run.results.droppedPassCount, 0);
  assert.equal(run.results.emptyFrameCount, 0);
});

// ─────────────────────────── the behaviour, pinned ────────────────────────

test("a sufficient depth retains every sample at the measured worst-case latency", async () => {
  const run = await runSegment({
    depth: SUFFICIENT_DEPTH,
    latencyFrames: WORST_LATENCY,
  });

  assert.equal(
    run.lostRefreshes,
    0,
    "every refresh in the segment must be armed and timed",
  );
  assert.equal(run.armedRefreshes, REFRESHES_PER_SEGMENT);
  assert.equal(
    run.results.readbackSkipCount,
    0,
    "no frame may go unsampled at a depth that covers the latency",
  );
  assert.equal(
    run.results.ringSaturated,
    false,
    "a ring that dropped nothing must not claim saturation",
  );
  assert.equal(
    run.results.frameCount,
    run.results.attemptedFrameCount,
    "every attempt must have produced a sample",
  );
  assertLedgerClosed(run.results, "sufficient depth");
  assert.equal(run.results.bufferCount, SUFFICIENT_DEPTH);
});

test("the depth a workload needs is its readback latency, not a fixed number", async () => {
  // Derived rather than asserted against a constant: if the relationship
  // between latency and required depth ever stops holding, this fails even
  // though SUFFICIENT_DEPTH still happens to work.
  for (const latency of [2, 3, 4, 5, 6, 7]) {
    const depth = await shallowestSufficientDepth(latency);
    assert.equal(
      depth,
      latency,
      `at a ${latency}-frame readback latency the shallowest ring that ` +
        `retains every sample must be ${latency} slots deep`,
    );
  }

  const needed = await shallowestSufficientDepth(WORST_LATENCY);
  assert.ok(
    needed !== null && needed <= SUFFICIENT_DEPTH,
    `the depth this lane would ship must cover the measured worst case; ` +
      `needed ${needed}, ships ${SUFFICIENT_DEPTH}`,
  );
});

// ───────────── raising the depth must not silence the failure ─────────────

test("a ring saturated beyond its depth still fails loudly", async () => {
  const run = await runSegment({
    depth: SUFFICIENT_DEPTH,
    latencyFrames: WORST_LATENCY * 3,
  });

  assert.ok(
    run.lostRefreshes > 0,
    "the driver must actually outrun this depth, or the test is vacuous",
  );
  assert.equal(
    run.results.ringSaturated,
    true,
    "a deeper ring that still cannot keep up must report saturation — " +
      "raising the depth may not convert a loud missing mean into a quiet " +
      "biased one",
  );
  assert.equal(run.results.readbackSkipCount, run.unarmedFrames);
  assertLedgerClosed(run.results, "over-run deep ring");
});

test("saturation is tied to the skip ledger, not tracked beside it", async () => {
  // The two must never disagree in either direction. A `ringSaturated` that
  // can read false while frames were skipped is exactly the quiet failure this
  // pins against, and one that reads true with nothing skipped makes the
  // signal unusable.
  for (const [depth, latency] of [
    [DEFAULT_DEPTH, 1],
    [DEFAULT_DEPTH, WORST_LATENCY],
    [SUFFICIENT_DEPTH, WORST_LATENCY],
    [SUFFICIENT_DEPTH, WORST_LATENCY * 3],
  ]) {
    const run = await runSegment({ depth, latencyFrames: latency });
    assert.equal(
      run.results.ringSaturated,
      run.results.readbackSkipCount > 0,
      `depth ${depth} at latency ${latency}: saturation must agree with the ` +
        `skip count`,
    );
  }
});

// ───────────────────────── the default, and its cost ──────────────────────

test("the default depth is unchanged and allocates exactly what it always did", () => {
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true);

  assert.equal(profiler.bufferCount, DEFAULT_DEPTH);
  assert.equal(
    device.querySets.length,
    DEFAULT_DEPTH,
    "one timestamp query set per slot, and no more than before",
  );
  assert.equal(
    device.buffers.length,
    DEFAULT_DEPTH * 2,
    "one resolve buffer and one readback buffer per slot",
  );
  assert.equal(profiler.getResults().bufferCount, DEFAULT_DEPTH);
});

test("a deeper ring costs one query set and two buffers per added slot", () => {
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true, SUFFICIENT_DEPTH);

  assert.equal(profiler.bufferCount, SUFFICIENT_DEPTH);
  assert.equal(device.querySets.length, SUFFICIENT_DEPTH);
  assert.equal(device.buffers.length, SUFFICIENT_DEPTH * 2);

  // The per-slot allocation is what the depth multiplies, so it is pinned.
  for (const querySet of device.querySets) {
    assert.equal(querySet.type, "timestamp");
    assert.equal(querySet.count, QUERIES_PER_SLOT);
  }
  for (const buffer of device.buffers) {
    assert.equal(buffer.size, QUERIES_PER_SLOT * 8);
  }
});

// ─────────────────────────── validation is loud ───────────────────────────

test("an unusable depth is rejected rather than clamped", () => {
  for (const bad of [0, 1, -3, 17, 3.5, Number.NaN, "8", null]) {
    assert.throws(
      () => new WebGPUTimestampProfiler(makeFakeDevice(), true, bad),
      /buffer count must be an integer/,
      `depth ${String(bad)} must be rejected, not silently clamped into range`,
    );
  }

  // `undefined` takes the parameter default, which must still be accepted.
  const profiler = new WebGPUTimestampProfiler(
    makeFakeDevice(),
    true,
    undefined,
  );
  assert.equal(profiler.bufferCount, DEFAULT_DEPTH);
});

test("a bad depth is rejected even on a device without the feature", () => {
  const featureless = {
    features: { has: () => false },
    createQuerySet: () => ({ destroy() {} }),
    createBuffer: () => new FakeBuffer({ size: 8 }),
  };
  assert.throws(
    () => new WebGPUTimestampProfiler(featureless, false, 99),
    /buffer count must be an integer/,
    "a device without timestamp-query is exactly where a bad depth would " +
      "otherwise go unnoticed until it reached a device that has it",
  );
});

// ──────────────────────────────── resizing ────────────────────────────────

test("resizing rebuilds the ring and releases the slots it replaced", () => {
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true);
  const originalQuerySets = [...device.querySets];
  const originalBuffers = [...device.buffers];

  profiler.setBufferCount(SUFFICIENT_DEPTH);

  assert.equal(profiler.bufferCount, SUFFICIENT_DEPTH);
  assert.equal(device.querySets.length, DEFAULT_DEPTH + SUFFICIENT_DEPTH);
  for (const querySet of originalQuerySets) {
    assert.equal(querySet.destroyed, true, "an idle old slot must be freed");
  }
  for (const buffer of originalBuffers) {
    assert.equal(buffer.destroyed, true);
  }
});

test("resizing does not destroy a slot whose readback is still in flight", async () => {
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true);

  profiler.beginFrame();
  assert.ok(profiler.getComputePassTimestampWrites("held"));
  profiler.endFrame(fakeEncoder);
  profiler.afterSubmit();
  await flushMicrotasks();

  const inFlight = readbackBufferFor(device, 0);
  assert.equal(inFlight.pending, true, "slot 0's map must still be waiting");

  profiler.setBufferCount(SUFFICIENT_DEPTH);
  assert.equal(
    inFlight.destroyed,
    false,
    "destroying a buffer under a pending map would reject that map with an " +
      "outcome the sample ledger has no bucket for",
  );

  inFlight.settle();
  await flushMicrotasks();
  assert.equal(
    inFlight.destroyed,
    true,
    "once the map settles the retired slot must be released, not leaked",
  );
});

test("resizing discards the measurement rather than pooling two depths", async () => {
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true);

  profiler.beginFrame();
  profiler.getComputePassTimestampWrites("a");
  profiler.endFrame(fakeEncoder);
  profiler.afterSubmit();
  readbackBufferFor(device, 0).settle();
  await flushMicrotasks();
  assert.equal(profiler.getResults().frameCount, 1);

  profiler.setBufferCount(SUFFICIENT_DEPTH);
  const after = profiler.getResults();
  assert.equal(
    after.attemptedFrameCount,
    0,
    "samples taken through a different depth come from a differently " +
      "instrumented frame population and must not be pooled with the new ones",
  );
  assert.equal(after.frameCount, 0);
  assert.equal(after.bufferCount, SUFFICIENT_DEPTH);
  assertLedgerClosed(after, "after resize");
});

test("resizing to the depth already in use is a no-op, and a bad resize throws", () => {
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true);
  const querySetCount = device.querySets.length;

  profiler.setBufferCount(DEFAULT_DEPTH);

  assert.equal(device.querySets.length, querySetCount, "nothing reallocated");
  for (const querySet of device.querySets) {
    assert.equal(querySet.destroyed, false);
  }
  assert.throws(
    () => profiler.setBufferCount(0),
    /buffer count must be an integer/,
  );
  assert.equal(
    profiler.bufferCount,
    DEFAULT_DEPTH,
    "a rejected resize is inert",
  );
});

test("a resize between beginFrame and endFrame leaves no attempt without an outcome", () => {
  // The resize can land mid-frame, and the frame that was already armed
  // against the old ring still reaches `endFrame`, where it counts an
  // attempt. An attempt with no terminal outcome is the silent loss the
  // whole ledger exists to make impossible, so the arming has to be
  // converted into one.
  const device = makeFakeDevice();
  const profiler = new WebGPUTimestampProfiler(device, true);

  profiler.beginFrame();
  assert.ok(profiler.getComputePassTimestampWrites("armed"));
  profiler.setBufferCount(SUFFICIENT_DEPTH);
  profiler.endFrame(fakeEncoder);

  const results = profiler.getResults();
  assert.equal(results.attemptedFrameCount, 1);
  assert.equal(
    results.readbackSkipCount,
    1,
    "the frame armed against the replaced ring can no longer be resolved, " +
      "so it is a skip",
  );
  assert.equal(results.frameCount, 0);
  assertLedgerClosed(results, "resize mid-frame");
});

// ─────────────────────── mutation: is any of it live? ─────────────────────

test("MUTATION — a depth that never reaches the ring fails the retention test", async () => {
  // Inertness, not deletion: the parameter is still declared, still validated,
  // still rejects a bad value. Only the assignment that carries it into the
  // ring is removed, so the ring stays three deep while every other surface
  // looks untouched. A spec that grepped the source for `bufferCount` would
  // sail straight past this.
  const Mutant = await importProfiler(
    (source) =>
      source.replace(
        "    this._bufferCount = validateBufferCount(bufferCount);",
        "    validateBufferCount(bufferCount);",
      ),
    "ring-depth inertness",
  );

  const device = makeFakeDevice();
  const profiler = new Mutant(device, true, SUFFICIENT_DEPTH);
  assert.throws(
    () => new Mutant(makeFakeDevice(), true, 0),
    /buffer count must be an integer/,
    "the mutant must still validate, or this is a deletion rather than an " +
      "inertness mutation",
  );
  assert.equal(
    device.querySets.length,
    DEFAULT_DEPTH,
    "the mutant must actually allocate the old ring",
  );
  assert.equal(profiler.bufferCount, DEFAULT_DEPTH);

  const run = await runSegment({
    depth: SUFFICIENT_DEPTH,
    latencyFrames: WORST_LATENCY,
    ProfilerClass: Mutant,
  });
  assert.ok(
    run.lostRefreshes > 0,
    "with the depth inert the segment must lose samples again — if it does " +
      "not, the retention test above is not measuring the configured depth",
  );
  assert.throws(
    () => assert.equal(run.lostRefreshes, 0),
    /Expected values to be strictly equal/,
    "the retention assertion must go red under this mutation",
  );
});

test("MUTATION — an inert saturation flag lets a dropped sample pass unreported", async () => {
  const Mutant = await importProfiler(
    (source) =>
      source.replaceAll(
        "ringSaturated: ledger.skipped > 0,",
        "ringSaturated: false && ledger.skipped > 0,",
      ),
    "saturation-flag inertness",
  );

  const run = await runSegment({
    depth: DEFAULT_DEPTH,
    latencyFrames: WORST_LATENCY,
    ProfilerClass: Mutant,
  });

  assert.ok(
    run.results.readbackSkipCount > 0,
    "the mutant must still drop frames, or this mutation proves nothing",
  );
  assert.equal(
    run.results.ringSaturated,
    false,
    "the mutation must make the flag inert — if it still reports true, the " +
      "flag is computed somewhere this mutation does not reach",
  );
  assert.throws(
    () => assert.equal(run.results.ringSaturated, true),
    /Expected values to be strictly equal/,
    "the loud-failure assertions must go red under this mutation",
  );
});

test("MUTATION — an inert mid-frame resize guard reopens the silent-loss hole", async () => {
  // Inertness again: the flag is still computed and still assigned, it just
  // can never be true. Deleting the whole branch would be caught by almost
  // anything; leaving it in place and unreachable is what a ledger-shaped
  // assertion has to catch.
  const Mutant = await importProfiler(
    (source) =>
      source.replace(
        "    const armedAgainstOldRing =" +
          NEWLINE +
          "      this._frameInProgress && this._currentFrameAvailable;",
        "    const armedAgainstOldRing =" +
          NEWLINE +
          "      false && this._frameInProgress && this._currentFrameAvailable;",
      ),
    "mid-frame resize guard inertness",
  );

  const device = makeFakeDevice();
  const profiler = new Mutant(device, true);
  profiler.beginFrame();
  assert.ok(profiler.getComputePassTimestampWrites("armed"));
  profiler.setBufferCount(SUFFICIENT_DEPTH);
  profiler.endFrame(fakeEncoder);

  const results = profiler.getResults();
  assert.equal(results.attemptedFrameCount, 1);
  assert.equal(
    results.sampleLedgerBalanced,
    false,
    "with the guard inert the attempt must fall out of the ledger — if it " +
      "still balances, the live test above is not measuring this guard",
  );
  assert.equal(results.unaccountedSampleCount, 1);
});
