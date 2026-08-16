// C11-193 — bounded environment-refresh drain + persistent target pool.
// @purpose Pins the C11-193 environment-refresh scheduler's no-starvation latency bound and the persistent target pool against a duck-typed fake GPU device.
// @status ACTIVE
//
// Both units are GPU-free logic living in TypeScript modules that are only
// bundled into the combined engine barrel, so this spec transpiles each source
// file with esbuild and imports the result (the pattern established by
// `attachment-demand-registry.spec.mjs`). The pool touches `createBuffer` /
// `createTexture` / `destroy` only, so a duck-typed fake device exercises it
// completely without a browser.
//
// The load-bearing contract here is NO-STARVATION. A 2026-08-01 review defect
// (`WEBGPU_DEBUGGING_LOG.md`, `C11-REVIEW-2026-08-01` defect 3) froze a
// multi-frame environment generation by gating its tick on consumer selection.
// Scheduling authority may reorder and bound work; it may never drop it. The
// tests below pin that as a hard latency bound rather than a code-shape check.
//
// Run: node --test Tools/visual-regression/environment-refresh-drain.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const webgpuDir = path.join(root, "packages/engine/Source/Renderer/WebGPU");

// WebGPU usage-flag namespaces the pool reads at allocation time. Real bit
// values from the spec so a wrong-flag regression would still be visible.
globalThis.GPUBufferUsage = Object.freeze({ UNIFORM: 0x40, COPY_DST: 0x08 });
globalThis.GPUTextureUsage = Object.freeze({ RENDER_ATTACHMENT: 0x10 });

async function importTs(relativePath) {
  const source = await readFile(path.join(webgpuDir, relativePath), "utf8");
  const { code } = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

const scheduler = await importTs("WebGPUEnvironmentRefreshScheduler.ts");
const pool = await importTs("WebGPUEnvironmentTargetPool.ts");

const {
  WebGPUEnvironmentRefreshScheduler,
  WebGPUEnvironmentRefreshUrgency: Urgency,
  WebGPUEnvironmentRefreshDecision: Decision,
  MAX_DEFERRAL_FRAMES,
  DEFAULT_ENVIRONMENT_REFRESH_BUDGET,
} = scheduler;
const { WebGPUEnvironmentTargetPool } = pool;

// ───────────────────────────── fake device ─────────────────────────────

function createFakeDevice(name = "device") {
  let nextId = 0;
  const created = [];
  const device = {
    name,
    created,
    limits: { minUniformBufferOffsetAlignment: 256 },
    createBuffer(descriptor) {
      const buffer = {
        kind: "buffer",
        id: `${name}-b${nextId++}`,
        size: descriptor.size,
        usage: descriptor.usage,
        label: descriptor.label,
        destroyed: false,
        destroy() {
          assert.equal(this.destroyed, false, `double destroy of ${this.id}`);
          this.destroyed = true;
        },
      };
      created.push(buffer);
      return buffer;
    },
    createTexture(descriptor) {
      const texture = {
        kind: "texture",
        id: `${name}-t${nextId++}`,
        size: descriptor.size,
        format: descriptor.format,
        usage: descriptor.usage,
        label: descriptor.label,
        destroyed: false,
        createView() {
          return { kind: "view", of: this.id };
        },
        destroy() {
          assert.equal(this.destroyed, false, `double destroy of ${this.id}`);
          this.destroyed = true;
        },
      };
      created.push(texture);
      return texture;
    },
  };
  return device;
}

const liveCount = (device, kind) =>
  device.created.filter((o) => o.kind === kind && !o.destroyed).length;

// ───────────────────── scheduler: budget + parity ──────────────────────

test("default budget is one deferrable grant per frame", () => {
  assert.equal(DEFAULT_ENVIRONMENT_REFRESH_BUDGET, 1);
  assert.equal(new WebGPUEnvironmentRefreshScheduler().budget, 1);
});

test("single requesting manager runs every frame (default-viewer parity)", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const manager = {};
  for (let frame = 0; frame < 40; frame++) {
    drain.beginFrame(0);
    const decision = drain.requestRefresh(manager, Urgency.HIGH);
    assert.equal(decision, Decision.RUN, `frame ${frame} must run`);
    drain.noteRefreshSubmitted(manager);
  }
  assert.equal(drain.hasPendingWork(), false);
});

test("a grant that never submits does not become the fairness anchor", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const failed = {};
  const waiting = {};

  drain.beginFrame(0);
  assert.equal(drain.requestRefresh(failed, Urgency.HIGH), Decision.RUN);
  // Simulate an encode failure: noteRefreshSubmitted is deliberately omitted.
  assert.equal(drain.requestRefresh(waiting, Urgency.HIGH), Decision.DEFER);
  assert.equal(drain.getRecord(failed).lastGrantFrameId, -1);
  assert.equal(drain.getRecord(failed).lastSubmitFrameId, -1);

  drain.beginFrame(0);
  assert.equal(
    drain.requestRefresh(failed, Urgency.HIGH),
    Decision.RUN,
    "work that never submitted must not yield as though it ran",
  );
  assert.equal(drain.getTelemetry().submissions, 0);
});

test("budget bounds how many deferrable refreshes start on one frame", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const managers = [{}, {}, {}, {}];
  drain.beginFrame(0);
  const decisions = managers.map((m) => drain.requestRefresh(m, Urgency.HIGH));
  assert.deepEqual(decisions, [
    Decision.RUN,
    Decision.DEFER,
    Decision.DEFER,
    Decision.DEFER,
  ]);
  const telemetry = drain.getTelemetry();
  assert.equal(telemetry.granted, 1);
  assert.equal(telemetry.deferred, 3);
  assert.equal(telemetry.pendingAtFrameEnd, 3);
});

test("a raised budget grants exactly that many", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler(3);
  const managers = [{}, {}, {}, {}, {}];
  drain.beginFrame(0);
  const runs = managers.filter(
    (m) => drain.requestRefresh(m, Urgency.HIGH) === Decision.RUN,
  ).length;
  assert.equal(runs, 3);
});

test("a non-positive or non-finite budget clamps to one, never zero", () => {
  for (const value of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY]) {
    const drain = new WebGPUEnvironmentRefreshScheduler(value);
    assert.equal(drain.budget, 1, `budget ${String(value)} must clamp to 1`);
    drain.beginFrame(0);
    assert.equal(drain.requestRefresh({}, Urgency.HIGH), Decision.RUN);
  }
});

// ─────────────────────── scheduler: no-starvation ──────────────────────

test("MANDATORY bypasses the budget entirely", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  drain.beginFrame(0);
  assert.equal(drain.requestRefresh({}, Urgency.HIGH), Decision.RUN);
  // Budget is now spent; MANDATORY still runs.
  for (let i = 0; i < 5; i++) {
    assert.equal(drain.requestRefresh({}, Urgency.MANDATORY), Decision.RUN);
  }
  const telemetry = drain.getTelemetry();
  assert.equal(telemetry.granted, 6);
  assert.equal(telemetry.deferrableGrants, 1);
  assert.equal(telemetry.deferred, 0);
  assert.equal(telemetry.mandatoryGrants, 5);
  assert.equal(telemetry.overBudgetGrants, 5);
});

test("MANDATORY work does not consume the deferrable slot", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const unpublished = {};
  const demanded = {};
  drain.beginFrame(0);

  assert.equal(
    drain.requestRefresh(unpublished, Urgency.MANDATORY),
    Decision.RUN,
  );
  assert.equal(drain.requestRefresh(demanded, Urgency.HIGH), Decision.RUN);

  const telemetry = drain.getTelemetry();
  assert.equal(telemetry.granted, 2);
  assert.equal(telemetry.mandatoryGrants, 1);
  assert.equal(telemetry.deferrableGrants, 1);
  assert.equal(telemetry.deferred, 0);
});

test("PROVEN_NONE is deprioritized, never skipped", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const quiet = {};
  const busy = {};
  let quietRuns = 0;
  for (let frame = 0; frame < 12; frame++) {
    drain.beginFrame(0);
    // The busy manager always asks first, so the quiet one only ever gets in
    // through yield or escalation.
    if (drain.requestRefresh(busy, Urgency.HIGH) === Decision.RUN) {
      drain.noteRefreshSubmitted(busy);
    }
    if (drain.requestRefresh(quiet, Urgency.NORMAL) === Decision.RUN) {
      quietRuns++;
      drain.noteRefreshSubmitted(quiet);
    }
  }
  assert.ok(
    quietRuns >= 5,
    `a PROVEN_NONE manager must still drain; got ${quietRuns} runs in 12 frames`,
  );
});

test("every request starts within MAX_DEFERRAL_FRAMES + 1 frames, at any contention", () => {
  const bound = MAX_DEFERRAL_FRAMES + 1;
  const scenarios = [2, 3, 10, 32];

  for (const managerCount of scenarios) {
    const label = `${managerCount} deferrable managers`;
    const drain = new WebGPUEnvironmentRefreshScheduler();
    const managers = Array.from({ length: managerCount }, () => ({}));
    // firstRequestFrame[i] is the frame the current outstanding request began.
    const firstRequestFrame = new Array(managerCount).fill(-1);
    const runCount = new Array(managerCount).fill(0);
    let worstLatency = 0;
    let worstDeferrable = 0;

    for (let frame = 0; frame < 200; frame++) {
      drain.beginFrame(0);
      for (let i = 0; i < managerCount; i++) {
        if (firstRequestFrame[i] < 0) {
          firstRequestFrame[i] = frame;
        }
        const decision = drain.requestRefresh(managers[i], Urgency.HIGH);
        if (decision === Decision.RUN) {
          const latency = frame - firstRequestFrame[i];
          worstLatency = Math.max(worstLatency, latency);
          worstDeferrable = Math.max(worstDeferrable, latency);
          firstRequestFrame[i] = -1;
          runCount[i]++;
          drain.noteRefreshSubmitted(managers[i]);
        }
      }
    }

    assert.ok(
      worstLatency <= bound,
      `${label}: worst start latency ${worstLatency} frames exceeds the ${bound}-frame bound`,
    );
    // A bound satisfied because nobody ever ran would be vacuous. Over 200
    // frames with a worst-case start latency of `bound`, every deferrable
    // manager must have run at least 200 / (bound + 1) times.
    const minimumRuns = Math.floor(200 / (bound + 1));
    for (let i = 0; i < managerCount; i++) {
      assert.ok(
        runCount[i] >= minimumRuns,
        `${label}: manager ${i} ran only ${runCount[i]} times in 200 frames (>= ${minimumRuns} required)`,
      );
    }
    if (managerCount > 1) {
      assert.ok(
        worstDeferrable >= 1,
        `${label}: expected real contention, saw none`,
      );
    }
  }
});

test("escalation fires and is reported when the cap is reached", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const victim = {};
  let escalatedGrants = 0;
  for (let frame = 0; frame < 8; frame++) {
    drain.beginFrame(0);
    // A fresh front-runner spends the deferrable slot without inheriting a
    // prior-frame yield debt. The persistent victim therefore reaches the hard
    // escalation path.
    const frontRunner = {};
    drain.requestRefresh(frontRunner, Urgency.HIGH);
    drain.noteRefreshSubmitted(frontRunner);
    drain.requestRefresh(victim, Urgency.NORMAL);
    escalatedGrants += drain.getTelemetry().escalatedGrants;
  }
  assert.ok(
    escalatedGrants >= 1,
    "the anti-starvation cap must have granted at least once",
  );
  const record = drain.getRecord(victim);
  assert.ok(
    record.maxDeferredFrames <= MAX_DEFERRAL_FRAMES,
    `victim waited ${record.maxDeferredFrames} frames, past the ${MAX_DEFERRAL_FRAMES} cap`,
  );
});

test("two equal managers alternate under a budget of one", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const a = {};
  const b = {};
  const runsA = [];
  const runsB = [];
  for (let frame = 0; frame < 10; frame++) {
    drain.beginFrame(0);
    if (drain.requestRefresh(a, Urgency.HIGH) === Decision.RUN) {
      runsA.push(frame);
      drain.noteRefreshSubmitted(a);
    }
    if (drain.requestRefresh(b, Urgency.HIGH) === Decision.RUN) {
      runsB.push(frame);
      drain.noteRefreshSubmitted(b);
    }
  }
  assert.ok(runsA.length >= 4, `A ran ${runsA.length} times in 10 frames`);
  assert.ok(runsB.length >= 4, `B ran ${runsB.length} times in 10 frames`);
  // Neither may go two consecutive frames without running.
  for (const runs of [runsA, runsB]) {
    for (let i = 1; i < runs.length; i++) {
      assert.ok(
        runs[i] - runs[i - 1] <= 2,
        `gap of ${runs[i] - runs[i - 1]} frames between runs`,
      );
    }
  }
});

test("a brand-new manager never yields on its very first request", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const waiter = {};
  drain.beginFrame(0);
  drain.requestRefresh({}, Urgency.HIGH); // spends the budget
  drain.requestRefresh(waiter, Urgency.HIGH); // pending, so "others pending"
  drain.beginFrame(0);
  const fresh = {};
  assert.equal(
    drain.requestRefresh(fresh, Urgency.HIGH),
    Decision.RUN,
    "a first-ever request must not be mistaken for a repeat runner",
  );
});

// ───────────────────────── scheduler: resume path ──────────────────────

test("a deferral arms the resume request exactly once per frame", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  drain.beginFrame(0);
  drain.requestRefresh({}, Urgency.HIGH);
  assert.equal(drain.consumeResumeRequest(), false, "no deferral, no resume");

  drain.requestRefresh({}, Urgency.HIGH); // defer 1
  drain.requestRefresh({}, Urgency.HIGH); // defer 2
  assert.equal(drain.consumeResumeRequest(), true);
  assert.equal(drain.consumeResumeRequest(), false, "armed once per frame");

  drain.requestRefresh({}, Urgency.HIGH);
  assert.equal(
    drain.consumeResumeRequest(),
    false,
    "a later same-frame deferral cannot re-arm after consumption",
  );
  assert.equal(drain.getTelemetry().resumeRequests, 1);

  drain.beginFrame(0);
  assert.equal(
    drain.consumeResumeRequest(),
    false,
    "a new frame starts disarmed",
  );
});

test("pending work is reported until it drains", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const a = {};
  const b = {};
  drain.beginFrame(0);
  drain.requestRefresh(a, Urgency.HIGH);
  drain.requestRefresh(b, Urgency.HIGH);
  assert.equal(drain.hasPendingWork(), true);
  assert.equal(drain.pendingCount, 1);

  drain.beginFrame(0);
  drain.requestRefresh(b, Urgency.HIGH);
  assert.equal(drain.hasPendingWork(), false);
});

test("a producer that stops requesting retires without starving anyone", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const a = {};
  const abandoned = {};
  drain.beginFrame(0);
  drain.requestRefresh(a, Urgency.HIGH);
  assert.equal(drain.requestRefresh(abandoned, Urgency.HIGH), Decision.DEFER);

  // `abandoned` never asks again — its dirty predicate went false.
  for (let frame = 0; frame < 5; frame++) {
    drain.beginFrame(0);
    drain.requestRefresh(a, Urgency.HIGH);
    drain.noteRefreshSubmitted(a);
  }
  assert.equal(drain.hasPendingWork(), false);
  assert.ok(drain.getTelemetry().retiredPending >= 0);
  const record = drain.getRecord(abandoned);
  assert.equal(record.pending, false);
  assert.equal(record.deferredFrames, 0, "a retired entry carries no debt");
});

// ─────────────────── scheduler: generation + lifecycle ─────────────────

test("a device-generation change drops every queued request", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const a = {};
  const b = {};
  drain.beginFrame(0);
  drain.requestRefresh(a, Urgency.HIGH);
  drain.requestRefresh(b, Urgency.HIGH);
  assert.equal(drain.pendingCount, 1);

  drain.beginFrame(1); // recovery advanced the generation
  assert.equal(drain.pendingCount, 0, "stale-device work must not be replayed");
  assert.equal(
    drain.getRecord(b),
    undefined,
    "entries describing lost-device work are dropped",
  );
  // And the first post-recovery request is served immediately.
  assert.equal(drain.requestRefresh(b, Urgency.MANDATORY), Decision.RUN);
});

test("reset clears the ledger and the pending queue", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const a = {};
  drain.beginFrame(0);
  drain.requestRefresh(a, Urgency.HIGH);
  drain.requestRefresh({}, Urgency.HIGH);
  drain.reset(7);
  assert.equal(drain.pendingCount, 0);
  assert.equal(drain.hasPendingWork(), false);
  assert.equal(drain.getRecord(a), undefined);
  assert.equal(drain.getTelemetry().resourceGeneration, 7);
  assert.equal(drain.frameId, 0);
});

test("the frame counter cannot wrap into a bogus comparison", () => {
  const drain = new WebGPUEnvironmentRefreshScheduler();
  const a = {};
  drain.beginFrame(0);
  drain.requestRefresh(a, Urgency.HIGH);
  // Force the wrap boundary.
  drain.reset(0);
  for (let i = 0; i < 3; i++) {
    drain.beginFrame(0);
  }
  assert.ok(Number.isSafeInteger(drain.frameId));
  assert.equal(drain.requestRefresh(a, Urgency.HIGH), Decision.RUN);
});

// ─────────────────────────── pool: buffer reuse ────────────────────────

test("a released parameter arena is reused, not recreated", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  const first = p.acquireParameterBuffer(1024, "arena");
  p.releaseParameterBuffer(first);
  const second = p.acquireParameterBuffer(1024, "arena");

  assert.equal(second.buffer, first.buffer, "same buffer must come back");
  assert.equal(liveCount(device, "buffer"), 1);
  const telemetry = p.getTelemetry();
  assert.equal(telemetry.bufferCreates, 1);
  assert.equal(telemetry.bufferHits, 1);
  assert.equal(telemetry.bufferAcquires, 2);
});

test("many sequential refreshes settle on one pooled arena", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  for (let refresh = 0; refresh < 200; refresh++) {
    p.beginFrame(refresh, device, 0);
    const handle = p.acquireParameterBuffer(4096, "arena");
    p.releaseParameterBuffer(handle);
  }
  assert.equal(
    device.created.filter((o) => o.kind === "buffer").length,
    1,
    "200 refreshes must not create 200 buffers",
  );
  assert.equal(p.getTelemetry().bufferHits, 199);
});

test("arena buckets round up and never hand back an undersized buffer", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  const small = p.acquireParameterBuffer(300, "arena");
  assert.equal(small.capacityBytes, 512);
  assert.ok(small.buffer.size >= 300);
  p.releaseParameterBuffer(small);

  // A same-bucket ask reuses; a larger ask must allocate its own bucket.
  const sameBucket = p.acquireParameterBuffer(512, "arena");
  assert.equal(sameBucket.buffer, small.buffer);
  p.releaseParameterBuffer(sameBucket);

  const bigger = p.acquireParameterBuffer(513, "arena");
  assert.equal(bigger.capacityBytes, 1024);
  assert.notEqual(bigger.buffer, small.buffer);
  assert.ok(bigger.buffer.size >= 513);
});

test("the idle free list is bounded", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  const handles = [];
  for (let i = 0; i < 6; i++) {
    handles.push(p.acquireParameterBuffer(1024, "arena"));
  }
  assert.equal(liveCount(device, "buffer"), 6);
  for (const handle of handles) {
    p.releaseParameterBuffer(handle);
  }
  assert.equal(
    liveCount(device, "buffer"),
    2,
    "surplus arenas must be destroyed on release, not accumulated",
  );
  assert.equal(p.getTelemetry().bufferIdle, 2);
});

test("arena usage flags stay UNIFORM | COPY_DST", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  const handle = p.acquireParameterBuffer(256, "arena");
  assert.equal(
    handle.buffer.usage,
    globalThis.GPUBufferUsage.UNIFORM | globalThis.GPUBufferUsage.COPY_DST,
  );
});

// ─────────────────────────── pool: depth targets ───────────────────────

test("a released depth target is reused for the same size and format", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  const first = p.acquireDepthTarget(256, "depth24plus", "capture depth");
  assert.equal(first.texture.format, "depth24plus");
  assert.equal(
    first.texture.usage,
    globalThis.GPUTextureUsage.RENDER_ATTACHMENT,
  );
  p.releaseDepthTarget(first);

  const second = p.acquireDepthTarget(256, "depth24plus", "capture depth");
  assert.equal(second.texture, first.texture);
  assert.equal(second.view, first.view, "the view is pooled with its texture");
  assert.equal(liveCount(device, "texture"), 1);
  assert.equal(p.getTelemetry().depthHits, 1);
});

test("depth targets of different sizes are separate pool keys", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  const a = p.acquireDepthTarget(256, "depth24plus", "d");
  p.releaseDepthTarget(a);
  const b = p.acquireDepthTarget(512, "depth24plus", "d");
  assert.notEqual(b.texture, a.texture);
  assert.equal(b.texture.size.width, 512);
});

test("several managers share one depth target across a frame", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  p.beginFrame(1, device, 0);
  for (let manager = 0; manager < 8; manager++) {
    const handle = p.acquireDepthTarget(256, "depth24plus", "d");
    p.releaseDepthTarget(handle);
  }
  assert.equal(
    device.created.filter((o) => o.kind === "texture").length,
    1,
    "8 sequential borrowers must share one allocation",
  );
});

// ──────────────────── pool: generation-keyed teardown ──────────────────

test("adopting a new device generation destroys the whole cache", () => {
  const device = createFakeDevice("lost");
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  const buffer = p.acquireParameterBuffer(1024, "arena");
  const depth = p.acquireDepthTarget(256, "depth24plus", "d");
  p.releaseParameterBuffer(buffer);
  p.releaseDepthTarget(depth);
  assert.equal(liveCount(device, "buffer"), 1);
  assert.equal(liveCount(device, "texture"), 1);

  const recovered = createFakeDevice("recovered");
  p.adopt(recovered, 1);
  assert.equal(liveCount(device, "buffer"), 0, "lost-device arenas destroyed");
  assert.equal(
    liveCount(device, "texture"),
    0,
    "lost-device targets destroyed",
  );
  assert.equal(p.resourceGeneration, 1);
  assert.equal(p.device, recovered);
  assert.equal(p.getTelemetry().generationResets, 1);

  // The recovered generation allocates fresh.
  const next = p.acquireParameterBuffer(1024, "arena");
  assert.equal(next.generation, 1);
  assert.equal(liveCount(recovered, "buffer"), 1);
});

test("adopt publishes the recovered tuple and drains siblings when old destroy throws", () => {
  const lost = createFakeDevice("lost-throwing");
  const p = new WebGPUEnvironmentTargetPool(lost, 4);
  const buffer = p.acquireParameterBuffer(1024, "arena");
  const depth = p.acquireDepthTarget(256, "depth24plus", "d");
  p.releaseParameterBuffer(buffer);
  p.releaseDepthTarget(depth);
  const destroyBuffer = buffer.buffer.destroy;
  const firstError = new Error("lost buffer destroy failed");
  buffer.buffer.destroy = function () {
    destroyBuffer.call(buffer.buffer);
    throw firstError;
  };
  const recovered = createFakeDevice("recovered-after-throw");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.doesNotThrow(() => p.adopt(recovered, 5));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(p.device, recovered);
  assert.equal(p.resourceGeneration, 5);
  assert.equal(buffer.buffer.destroyed, true);
  assert.equal(depth.texture.destroyed, true);
  assert.equal(p.getTelemetry().bufferIdle, 0);
  assert.equal(p.getTelemetry().depthIdle, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1], firstError);

  const fresh = p.acquireParameterBuffer(1024, "fresh arena");
  assert.equal(fresh.generation, 5);
  assert.ok(fresh.buffer.id.startsWith("recovered-after-throw-"));
});

test("a stale-generation handle is destroyed on release, never pooled", () => {
  const device = createFakeDevice("lost");
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  const stale = p.acquireParameterBuffer(1024, "arena");
  const staleDepth = p.acquireDepthTarget(256, "depth24plus", "d");

  p.adopt(createFakeDevice("recovered"), 1);
  // The borrower only finds out at release time, which is exactly the shape of
  // an in-flight refresh that spanned a device loss.
  p.releaseParameterBuffer(stale);
  p.releaseDepthTarget(staleDepth);

  assert.equal(stale.buffer.destroyed, true);
  assert.equal(staleDepth.texture.destroyed, true);
  assert.equal(p.getTelemetry().staleReleases, 2);
  assert.equal(
    p.getTelemetry().bufferIdle,
    0,
    "a lost-device buffer must never enter the free list",
  );
  assert.equal(p.getTelemetry().depthIdle, 0);
});

test("same-generation handles from an old device are destroyed on release", () => {
  const lost = createFakeDevice("lost-same-generation");
  const recovered = createFakeDevice("recovered-same-generation");
  const p = new WebGPUEnvironmentTargetPool(lost, 9);
  const staleBuffer = p.acquireParameterBuffer(1024, "arena");
  const staleDepth = p.acquireDepthTarget(256, "depth24plus", "d");

  // Device identity is an independent half of the ownership tuple. Embedders
  // and synthetic recovery hosts may swap the physical device while retaining
  // their numeric generation, so a late release must check both.
  p.adopt(recovered, 9);
  p.releaseParameterBuffer(staleBuffer);
  p.releaseDepthTarget(staleDepth);

  assert.equal(staleBuffer.buffer.destroyed, true);
  assert.equal(staleDepth.texture.destroyed, true);
  assert.equal(p.getTelemetry().staleReleases, 2);
  assert.equal(p.getTelemetry().bufferIdle, 0);
  assert.equal(p.getTelemetry().depthIdle, 0);

  const freshBuffer = p.acquireParameterBuffer(1024, "fresh arena");
  const freshDepth = p.acquireDepthTarget(256, "depth24plus", "fresh depth");
  assert.equal(freshBuffer.device, recovered);
  assert.equal(freshDepth.device, recovered);
  assert.notEqual(freshBuffer.buffer, staleBuffer.buffer);
  assert.notEqual(freshDepth.texture, staleDepth.texture);
});

test("adopting the same identity is a no-op", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 3);
  const handle = p.acquireParameterBuffer(1024, "arena");
  p.releaseParameterBuffer(handle);
  p.adopt(device, 3);
  assert.equal(handle.buffer.destroyed, false);
  assert.equal(p.getTelemetry().generationResets, 0);
  assert.equal(p.acquireParameterBuffer(1024, "arena").buffer, handle.buffer);
});

test("destroy releases the cache and later releases destroy rather than pool", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  const pooled = p.acquireParameterBuffer(1024, "arena");
  p.releaseParameterBuffer(pooled);
  const borrowed = p.acquireDepthTarget(256, "depth24plus", "d");

  p.destroy();
  assert.equal(pooled.buffer.destroyed, true);
  assert.equal(p.isDestroyed, true);

  p.releaseDepthTarget(borrowed);
  assert.equal(borrowed.texture.destroyed, true);
  assert.equal(liveCount(device, "texture"), 0);
  p.destroy(); // idempotent
});

test("null releases are tolerated", () => {
  const p = new WebGPUEnvironmentTargetPool(createFakeDevice(), 0);
  p.releaseParameterBuffer(null);
  p.releaseDepthTarget(null);
  assert.equal(p.getTelemetry().bufferDestroys, 0);
});

// ──────────────────────────── pool: idle trim ──────────────────────────

test("the idle trim never destroys an entry used on the current frame", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  p.beginFrame(500, device, 0);
  const handle = p.acquireParameterBuffer(1024, "arena");
  const depth = p.acquireDepthTarget(256, "depth24plus", "d");
  // Release-before-submit is the real call order; the trim must not be allowed
  // to destroy a resource whose commands have not been submitted yet.
  p.releaseParameterBuffer(handle);
  p.releaseDepthTarget(depth);
  p.trim(500);
  assert.equal(handle.buffer.destroyed, false);
  assert.equal(depth.texture.destroyed, false);
});

test("the idle trim reclaims entries left unused past the window", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  p.beginFrame(10, device, 0);
  const handle = p.acquireParameterBuffer(1024, "arena");
  const depth = p.acquireDepthTarget(256, "depth24plus", "d");
  p.releaseParameterBuffer(handle);
  p.releaseDepthTarget(depth);

  p.trim(100);
  assert.equal(handle.buffer.destroyed, false, "still inside the idle window");

  p.trim(10000);
  assert.equal(handle.buffer.destroyed, true);
  assert.equal(depth.texture.destroyed, true);
  assert.equal(p.getTelemetry().bufferIdle, 0);
  assert.equal(p.getTelemetry().depthIdle, 0);
  assert.ok(p.getTelemetry().trimmed >= 2);
});

test("trim after destroy is inert", () => {
  const device = createFakeDevice();
  const p = new WebGPUEnvironmentTargetPool(device, 0);
  const handle = p.acquireParameterBuffer(1024, "arena");
  p.releaseParameterBuffer(handle);
  p.destroy();
  p.trim(10000); // must not double-destroy
  assert.equal(handle.buffer.destroyed, true);
});

// ─────────────────── wiring anchors in the shipped sources ─────────────

const readSource = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const managerSource = readSource(
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
);
const captureSource = readSource(
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
);
const contextSource = readSource(
  "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
);
const iblSource = readSource(
  "packages/engine/Source/Renderer/WebGPU/WebGPUIBLPipeline.ts",
);
const tilesetSource = readSource(
  "packages/engine/Source/Scene/Cesium3DTileset.js",
);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source anchor: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source anchor: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("the tileset environment tick stays outside every consumer gate", () => {
  // Regression guard for C11-REVIEW-2026-08-01 defect 3. The scheduler may
  // bound this manager's GPU work, but the tick that advances its state machine
  // must never move behind `show` / selected-tiles.
  const section = sourceSection(
    tilesetSource,
    "if (passOptions.isRender) {",
    "// Update clipping polygons",
  );
  assert.match(section, /environmentMapManager\.update\(frameState\);/);
  const tickEnd =
    section.indexOf("environmentMapManager.update(frameState);") +
    "environmentMapManager.update(frameState);".length;
  const beforeTick = section.slice(0, tickEnd);
  assert.doesNotMatch(beforeTick, /this\.show/);
  assert.doesNotMatch(beforeTick, /_selectedTiles/);
});

test("the deferred path commits no refresh bookkeeping", () => {
  // Every `last*` commit and `needsUpdate = false` must live inside the exact
  // post-submit transaction; a deferral must never consume the dirty edge.
  const granted = sourceSection(
    managerSource,
    "if (refreshGranted) {",
    "if (cache.pendingRefresh === null && !cache.needsUpdate)",
  );
  const commitSection = sourceSection(
    managerSource,
    "function commitDynamicEnvironmentRefresh(",
    "function settlePendingDynamicEnvironmentRefresh(",
  );
  for (const expectedAssignment of [
    "cache.needsUpdate = false;",
    "cache.lastSunDirX = state.sunDirection.x;",
    "cache.lastSceneCaptureMode = state.sceneCaptureMode;",
    "cache.lastCloudCoverage = state.cloudCoverage;",
    "cache.lastCloudRevision = state.cloudRevision;",
  ]) {
    assert.ok(
      commitSection.includes(expectedAssignment),
      `${expectedAssignment} must be owned by the refresh commit transaction`,
    );
    assert.equal(
      managerSource.split(expectedAssignment).length - 1,
      1,
      `${expectedAssignment} must appear exactly once, only in the commit transaction`,
    );
  }
  assert.match(granted, /commitDynamicEnvironmentRefresh\(/);
});

test("publication survives a deferral", () => {
  // The resource publication is deliberately AFTER the granted branch, so a
  // deferred manager keeps publishing the resources it already has.
  const grantedIndex = managerSource.indexOf("if (refreshGranted) {");
  const publishIndex = managerSource.indexOf(
    "if (cache.pendingRefresh === null && !cache.needsUpdate)",
    grantedIndex,
  );
  assert.ok(grantedIndex > 0 && publishIndex > grantedIndex);
  const between = managerSource.slice(grantedIndex, publishIndex);
  assert.match(between, /commitDynamicEnvironmentRefresh\(/);
});

test("an unpublished manager is never deferrable", () => {
  const section = sourceSection(
    managerSource,
    "const hasPublishedResources =",
    "const refreshGranted =",
  );
  assert.match(section, /!cache\.needsUpdate/);
  assert.match(section, /cache\.iblCache !== null/);
  assert.match(section, /cache\.shBuffer !== null/);
  assert.match(section, /ENV_REFRESH_URGENCY_MANDATORY/);
});

test("every deferral arms a resume path before returning", () => {
  const section = sourceSection(
    managerSource,
    "function scheduleEnvironmentRefresh(",
    "function noteEnvironmentRefreshSubmitted(",
  );
  assert.match(section, /ENV_REFRESH_DECISION_DEFER/);
  assert.match(
    section,
    /afterRender\.push\(requestRenderForEnvironmentRefreshResume\)/,
  );
  // A context without the seam runs unconditionally — the historical behavior.
  assert.match(section, /typeof schedule !== "function"[\s\S]*return true;/);
});

test("the context resets the drain and the pool on recovery and teardown", () => {
  const recovery = sourceSection(
    contextSource,
    "this._deviceResourceGeneration += 1;",
    "this._fireDeviceInvalidated();",
  );
  assert.match(recovery, /_environmentRefreshScheduler\.reset\(/);
  assert.match(recovery, /_environmentTargetPool[\s\S]*\.adopt\(/);

  const teardown = sourceSection(
    contextSource,
    "this._pendingTextureMipJobs.length = 0;",
    "continueFinalCleanupAfter(() => this._shaderCache.destroy());",
  );
  assert.match(teardown, /_environmentRefreshScheduler\.reset\(/);
  assert.match(
    teardown,
    /const environmentTargetPool = this\._environmentTargetPool;[\s\S]*this\._environmentTargetPool = null;[\s\S]*continueFinalCleanupAfter\(\(\) => environmentTargetPool\?\.destroy\(\)\);/,
  );
});

test("the drain advances once per frame from beginFrame", () => {
  const section = sourceSection(
    contextSource,
    "this._environmentDemandRegistry.beginFrame(",
    "this._clearCallsThisFrame = 0;",
  );
  assert.match(section, /_environmentRefreshScheduler\.beginFrame\(/);
  assert.match(section, /_environmentTargetPool[\s\S]*\.beginFrame\(/);
});

test("the encoding scope returns its arena to the pool instead of destroying it", () => {
  const section = sourceSection(
    iblSource,
    "function settleIBLCommandEncodingScope(",
    "function destroyIBLCommandEncodingScope(",
  );
  assert.match(section, /releaseParameterBuffer\(scope\.parameterHandle\)/);
  // The unpooled caller keeps the historical own-and-destroy lifetime.
  assert.match(section, /scope\.parameterBuffer\.destroy\(\);/);
});

test("the capture releases its borrowed depth target on every exit", () => {
  assert.match(captureSource, /targetPool\.releaseDepthTarget\(pooledDepth\)/);
  const finallySection = sourceSection(
    captureSource,
    "uniformState.updateCamera(mainCamera);",
    "if (!encoder || globeDrawCount + modelDrawCount === 0)",
  );
  assert.match(
    finallySection,
    /releaseDepthTarget\(pooledDepth\)/,
    "release must be in the finally so a throw cannot leak the target",
  );
});
