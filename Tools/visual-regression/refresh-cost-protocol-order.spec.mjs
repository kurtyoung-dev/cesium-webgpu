// The refresh-cost protocol's PRE-SEGMENT PRECONDITION.
//
// `probe-eclipse-cloud-response.mjs` runs its measurement inside
// `page.evaluate`, so the precondition it establishes before every timed
// segment cannot be imported: it is a closure inside a callback that only
// exists once a browser has it. It therefore travels in a marker-delimited
// block, exactly as the two closure describers beside it do, and this spec
// extracts that block, compiles the REAL text, and drives it against a device
// model whose only inputs are the two facts a GPU decides for itself — when
// the submitted queue retires, and when a readback's map resolves.
//
// What the model is for: `drainPendingReadbacks` races a bounded timer against
// the outstanding readbacks and reports `undrained` on expiry. A bounded race
// cannot tell "never" from "later than the bound", so the same readback yields
// two opposite verdicts depending only on how much of the device's backlog is
// still ahead of it. Cases 1 and 2 below are that pair: one readback, one
// device, two verdicts, separated by nothing but whether a queue fence ran
// first. Case 3 is the honesty bar in the other direction — a readback that
// genuinely never settles must still refuse, loudly, with the fence in place.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  ECLIPSE_CLOUD_GATE_PREDICATES,
  ECLIPSE_CLOUD_PARITY_PREDICATES,
} from "./lib/eclipse-cloud-response-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE_FILE = path.join(here, "probe-eclipse-cloud-response.mjs");
const probeSource = fs.readFileSync(PROBE_FILE, "utf8").replace(/\r\n/g, "\n");

/**
 * Read one marker-delimited block out of the probe, dedented to column 0.
 *
 * Deliberately a local copy rather than an import: the gate module's own
 * extractor is not exported, and this spec must not depend on a file another
 * lane owns for the mechanism it is testing.
 *
 * @param {string} name
 * @returns {string}
 */
function extractMarkedBlock(name) {
  const begin = `// ==BEGIN ${name}==`;
  const end = `// ==END ${name}==`;
  const start = probeSource.indexOf(begin);
  const finish = probeSource.indexOf(end);
  assert.ok(start >= 0, `the probe does not carry ${begin}`);
  assert.ok(finish > start, `the probe does not carry ${end} after ${begin}`);
  const lines = probeSource
    .slice(start + begin.length, finish)
    .replace(/^\n/, "")
    .replace(/\n[ \t]*$/, "")
    .split("\n");
  const common =
    lines
      .filter((line) => line.trim().length > 0)
      .map((line) => line.match(/^[ \t]*/u)[0])
      .sort((a, b) => a.length - b.length)[0] ?? "";
  return lines
    .map((line) => (line.startsWith(common) ? line.slice(common.length) : line))
    .join("\n");
}

/**
 * Compile the named blocks together and hand back the named bindings. The
 * source executed here is the probe's own, byte for byte after dedent.
 *
 * @param {string[]} blockNames
 * @param {string[]} exported
 * @returns {Record<string, Function>}
 */
function compileBlocks(blockNames, exported) {
  const body = `${blockNames
    .map((name) => extractMarkedBlock(name))
    .join("\n")}\nreturn { ${exported.join(", ")} };`;
  return vm.compileFunction(body, [], {
    filename: `probe-eclipse-cloud-response.mjs#${blockNames.join("+")}`,
  })();
}

const {
  describeRefreshCostDrainClosure,
  describeRefreshCostFenceClosure,
  describeRefreshCostSetupDrain,
  establishRefreshCostPrecondition,
} = compileBlocks(
  ["refresh-cost-drain-closure", "refresh-cost-precondition-protocol"],
  [
    "describeRefreshCostDrainClosure",
    "describeRefreshCostFenceClosure",
    "describeRefreshCostSetupDrain",
    "establishRefreshCostPrecondition",
  ],
);

const DRAIN_TIMEOUT_MS = 5000;
const FENCE_TIMEOUT_MS = 30000;

/**
 * A device whose behaviour is fixed by two instants on a virtual clock.
 *
 * `queueRetiresAtMs` is when `onSubmittedWorkDone()` would resolve.
 * `readbackSettlesAtMs` is when the outstanding `mapAsync` would resolve; it
 * may be `Infinity` (a genuinely stuck readback). A readback cannot resolve
 * before the submission that wrote its buffer has retired, so the constructor
 * refuses an unphysical pair rather than letting a future edit assert against
 * a device that could not exist.
 *
 * `drain` reproduces `WebGPUTimestampProfiler.drainPendingReadbacks`: the
 * empty early return when nothing is outstanding, and otherwise
 * `drained = outstanding.length - undrained` with `undrained` read from the
 * live set after the race.
 *
 * @param {{queueRetiresAtMs: number, readbackSettlesAtMs: number}} options
 */
function deviceModel({ queueRetiresAtMs, readbackSettlesAtMs }) {
  assert.ok(
    readbackSettlesAtMs >= queueRetiresAtMs,
    "a readback cannot resolve before the queue that wrote its buffer retires",
  );
  let nowMs = 0;
  const calls = [];
  let queueRetired = false;
  return {
    calls,
    nowMs: () => nowMs,
    fence: async (timeoutMs) => {
      const startMs = nowMs;
      calls.push({ call: "fence", atMs: startMs });
      if (queueRetiresAtMs - startMs <= timeoutMs) {
        nowMs = Math.max(nowMs, queueRetiresAtMs);
        queueRetired = true;
        return {
          completed: true,
          timedOut: false,
          error: null,
          durationMs: nowMs - startMs,
        };
      }
      nowMs = startMs + timeoutMs;
      return {
        completed: false,
        timedOut: true,
        error: null,
        durationMs: timeoutMs,
      };
    },
    drain: async (timeoutMs) => {
      calls.push({ call: "drain", atMs: nowMs, queueRetired });
      if (readbackSettlesAtMs <= nowMs) {
        // The promise already left `_activeReadbacks`: the empty early return.
        return { drained: 0, undrained: 0, abandoned: 0, timedOut: false };
      }
      if (readbackSettlesAtMs - nowMs <= timeoutMs) {
        nowMs = readbackSettlesAtMs;
        return { drained: 1, undrained: 0, abandoned: 0, timedOut: false };
      }
      nowMs += timeoutMs;
      return { drained: 0, undrained: 1, abandoned: 0, timedOut: true };
    },
  };
}

/** The protocol as it shipped before the fence: straight to the drain. */
const unfencedPrecondition = async (options) => {
  const preDrain = await options.drain(options.drainTimeoutMs);
  return {
    preFence: { completed: true, timedOut: false, error: null, durationMs: 0 },
    preDrain,
  };
};

const runPrecondition = (
  device,
  establish = establishRefreshCostPrecondition,
) =>
  establish({
    fence: device.fence,
    drain: device.drain,
    fenceTimeoutMs: FENCE_TIMEOUT_MS,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
  });

// The receipt this models: pair 0 eclipse reported
// `{drained:0, undrained:1, abandoned:0, timedOut:true}` after ~1,600 warm-up
// frames were submitted without a fence, and the SAME segment's post-loop
// drain then took the empty early return — so the readback had settled by the
// time the segment ended. 6,000/6,050 ms is that shape against the shipped
// 5,000 ms drain bound.
const LATE_DEVICE = () =>
  deviceModel({ queueRetiresAtMs: 6000, readbackSettlesAtMs: 6050 });

test("case 1 — a readback the device has not yet reached closes once the fence has waited for the device", async () => {
  const device = LATE_DEVICE();
  const { preFence, preDrain } = await runPrecondition(device);

  assert.deepEqual(preDrain, {
    drained: 1,
    undrained: 0,
    abandoned: 0,
    timedOut: false,
  });
  assert.equal(describeRefreshCostDrainClosure(preDrain), "");
  assert.equal(describeRefreshCostFenceClosure(preFence), "");
  assert.equal(preFence.completed, true);
  assert.equal(preFence.durationMs, 6000);
});

test("case 2 — the same readback on the same device, drained without the fence, is reported undrained and timed out", async () => {
  const device = LATE_DEVICE();
  const { preDrain } = await runPrecondition(device, unfencedPrecondition);

  assert.deepEqual(preDrain, {
    drained: 0,
    undrained: 1,
    abandoned: 0,
    timedOut: true,
  });
  assert.equal(
    describeRefreshCostDrainClosure(preDrain),
    "timedOut=true, undrained=1",
  );
});

test("case 3 — a readback that never settles still refuses, with the fence in place (the fence cannot hide a stuck readback)", async () => {
  const device = deviceModel({
    queueRetiresAtMs: 100,
    readbackSettlesAtMs: Number.POSITIVE_INFINITY,
  });
  const { preFence, preDrain } = await runPrecondition(device);

  assert.equal(preFence.completed, true, "the queue itself retired");
  assert.equal(describeRefreshCostFenceClosure(preFence), "");
  assert.deepEqual(preDrain, {
    drained: 0,
    undrained: 1,
    abandoned: 0,
    timedOut: true,
  });
  assert.equal(
    describeRefreshCostDrainClosure(preDrain),
    "timedOut=true, undrained=1",
  );
  // The drain kept its own bound behind the fence rather than inheriting the
  // fence's: it refused 5,000 ms after the queue retired at 100 ms.
  assert.equal(device.nowMs(), 100 + DRAIN_TIMEOUT_MS);
});

test("case 4 — a fence that exhausts its own bound is a named refusal in its own right", async () => {
  const device = deviceModel({
    queueRetiresAtMs: 60000,
    readbackSettlesAtMs: 60050,
  });
  const { preFence, preDrain } = await runPrecondition(device);

  assert.equal(preFence.completed, false);
  assert.equal(preFence.timedOut, true);
  assert.equal(preFence.durationMs, FENCE_TIMEOUT_MS);
  assert.equal(
    describeRefreshCostFenceClosure(preFence),
    "timedOut=true, error=null",
  );
  // And the drain behind it refuses too, so the segment cannot read as clean.
  assert.notEqual(describeRefreshCostDrainClosure(preDrain), "");
});

test("case 5 — a fence with no queue API to call is a named refusal, not a silent pass", () => {
  assert.equal(
    describeRefreshCostFenceClosure({
      completed: false,
      timedOut: false,
      error: "WebGPU queue completion API is unavailable",
      durationMs: 0,
    }),
    "timedOut=false, error=WebGPU queue completion API is unavailable",
  );
  assert.equal(describeRefreshCostFenceClosure(null), "fence absent");
  assert.equal(describeRefreshCostFenceClosure(undefined), "fence absent");
  assert.equal(
    describeRefreshCostFenceClosure({
      completed: true,
      timedOut: false,
      error: null,
      durationMs: 12,
    }),
    "",
  );
});

test("case 6 — the drain is not started until the fence has RESOLVED, under real async scheduling", async () => {
  const order = [];
  let fenceResolved = false;
  const { preDrain } = await establishRefreshCostPrecondition({
    fence: async (timeoutMs) => {
      order.push(`fence:start:${timeoutMs}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      fenceResolved = true;
      order.push("fence:resolve");
      return { completed: true, timedOut: false, error: null, durationMs: 20 };
    },
    drain: async (timeoutMs) => {
      order.push(`drain:start:${timeoutMs}:fenceResolved=${fenceResolved}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { drained: 1, undrained: 0, abandoned: 0, timedOut: false };
    },
    fenceTimeoutMs: FENCE_TIMEOUT_MS,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
  });

  assert.deepEqual(order, [
    `fence:start:${FENCE_TIMEOUT_MS}`,
    "fence:resolve",
    `drain:start:${DRAIN_TIMEOUT_MS}:fenceResolved=true`,
  ]);
  assert.equal(describeRefreshCostDrainClosure(preDrain), "");
});

test("case 7 — the fence carries its OWN bound, larger than the drain's, and the drain's bound is unchanged at 5000", () => {
  // The protocol config is a literal inside the probe's unexported runner, so
  // it is read by evaluating the shipped literal rather than by importing it.
  const marker = "refreshCostProtocol: {";
  const start = probeSource.indexOf(marker);
  assert.ok(start >= 0, "the probe does not declare refreshCostProtocol");
  let depth = 0;
  let finish = -1;
  for (let i = start + marker.length - 1; i < probeSource.length; i++) {
    if (probeSource[i] === "{") depth++;
    else if (probeSource[i] === "}") {
      depth--;
      if (depth === 0) {
        finish = i;
        break;
      }
    }
  }
  assert.ok(finish > start, "refreshCostProtocol's literal does not close");
  const literal = probeSource.slice(start + marker.length - 1, finish + 1);
  const protocol = vm.runInNewContext(`(${literal})`, {
    REFRESH_COST_PROTOCOL_VERSION: 0,
    REFRESH_COST_GPU_TIME_PROTOCOL: {},
    REFRESH_COST_WEBGPU_GPU_UNAVAILABLE_REASON: "",
    REFRESH_COST_WEBGL_GPU_UNAVAILABLE_REASON: "",
  });

  assert.equal(
    protocol.readbackTimeoutMs,
    5000,
    "the drain bound must not be widened — a stuck readback still has to fail",
  );
  assert.equal(typeof protocol.preSegmentFenceTimeoutMs, "number");
  assert.ok(
    protocol.preSegmentFenceTimeoutMs > protocol.readbackTimeoutMs,
    `the fence bound ${protocol.preSegmentFenceTimeoutMs} must exceed the drain bound ${protocol.readbackTimeoutMs}, or it only moves the refusal one line up`,
  );
});

test("case 8 — the drain taken before the ring resize is described, not discarded", () => {
  assert.equal(
    describeRefreshCostSetupDrain(
      { drained: 0, undrained: 0, abandoned: 0, timedOut: false },
      describeRefreshCostDrainClosure,
    ),
    "",
  );
  assert.equal(
    describeRefreshCostSetupDrain(
      { drained: 0, undrained: 1, abandoned: 0, timedOut: true },
      describeRefreshCostDrainClosure,
    ),
    "the pre-resize GPU readback drain did not close (timedOut=true, undrained=1)",
  );
  assert.equal(
    describeRefreshCostSetupDrain(
      { drained: 0, undrained: 0, abandoned: 2, timedOut: false },
      describeRefreshCostDrainClosure,
    ),
    "the pre-resize GPU readback drain did not close (abandoned=2)",
  );
  assert.equal(
    describeRefreshCostSetupDrain(null, describeRefreshCostDrainClosure),
    "the pre-resize GPU readback drain did not close (drain absent)",
  );
});

test("case 9 — nothing the fence publishes can reach a verdict", () => {
  for (const name of [
    "preFence",
    "preFenceMs",
    "preResizeDrain",
    "preSegmentFenceTimeoutMs",
  ]) {
    assert.ok(
      !ECLIPSE_CLOUD_GATE_PREDICATES.includes(name),
      `${name} must stay reported-only, not a gate predicate`,
    );
    assert.ok(
      !ECLIPSE_CLOUD_PARITY_PREDICATES.includes(name),
      `${name} must stay reported-only, not a parity predicate`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring. These four are TEXT SHAPE, not behaviour, and are declared as such:
// the call sites live inside `RUN_IBL_SWEEP`, which only exists once a browser
// has evaluated it, so no Node spec can execute them. An `if (false && …)`
// mutant that leaves the text in place survives every assertion below. What
// asserts the wiring is the Edge re-run of leg (e), whose pre-registered
// reading is in this batch's landing packet.
// ─────────────────────────────────────────────────────────────────────────────

test("wiring (text shape) — the segment's precondition runs through the extracted protocol and publishes the fence", () => {
  assert.match(
    probeSource,
    /const \{ preFence, preDrain \} = await establishRefreshCostPrecondition\(\{/,
  );
  assert.match(probeSource, /fence: timedQueueFence,/);
  assert.match(
    probeSource,
    /fenceTimeoutMs: cfg\.refreshCostProtocol\.preSegmentFenceTimeoutMs,/,
  );
  assert.match(
    probeSource,
    /drainTimeoutMs: cfg\.refreshCostProtocol\.readbackTimeoutMs,/,
  );
  assert.match(probeSource, /preFenceMs: preFence\.durationMs,/);
  assert.match(
    probeSource,
    /const preFenceOffenders = describeRefreshCostFenceClosure\(preFence\);/,
  );
});

test("wiring (text shape) — the pre-resize drain is captured, checked and published", () => {
  assert.match(
    probeSource,
    /setupDrain = await profiler\.drainPendingReadbacks\(/,
  );
  assert.match(
    probeSource,
    /const setupDrainReason = describeRefreshCostSetupDrain\(/,
  );
  assert.match(probeSource, /\.\.\.setupInvalidReasons,/);
  assert.match(probeSource, /preResizeDrain: setupDrain,/);
});

test("wiring (text shape) — the post-segment fence keeps its shipped call and bound", () => {
  assert.match(
    probeSource,
    /const queueDrain = await awaitQueueCompletion\(\);/,
  );
  assert.match(
    probeSource,
    /const awaitQueueCompletion = async \(\n\s*timeoutMs = cfg\.refreshCostProtocol\.readbackTimeoutMs,\n\s*\) => \{/,
  );
});

test("wiring (text shape) — both warm-up legs yield through the compositor on a bounded cadence", () => {
  const compositorYields = probeSource.match(
    /if \(\(f & 63\) === 63\) \{\n\s*await new Promise\(\(r\) => requestAnimationFrame\(r\)\);\n\s*\} else if \(\(f & 31\) === 31\) \{/g,
  );
  assert.equal(
    compositorYields?.length,
    2,
    "both 801-frame warm-up legs must cap how far the CPU may run ahead",
  );
});
