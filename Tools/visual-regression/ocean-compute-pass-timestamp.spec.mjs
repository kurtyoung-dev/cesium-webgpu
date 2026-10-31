// ocean-compute-pass-timestamp.spec.mjs — the FFT ocean's compute chain reaches the GPU pass profiler.
// @purpose Runs the real WebGPUOceanRenderer.ts over the recording device and pins that its single compute pass is requested from the context's withComputePassTimestamps under the label "Ocean FFT single-pass compute chain" (so PF-2 can time the iFFT chain), carries the returned timestampWrites with and without a frame encoder, and stays the same frozen descriptor, with an identical dispatch sequence, when the profiler is off or the context has no accessor.
// @status ACTIVE
//
// These tests fail if:
//   - the ocean opens its compute pass without asking the context for
//     timestamp writes, so `CesiumDebug.gpuPassCost(true)` never lists the
//     chain and PF-2 cannot compare two Stockham dispatches with the 32
//     ping-pong passes;
//   - the pass label drifts from the string PF-2 keys on;
//   - arming the profiler changes which dispatches the chain records;
//   - the default path starts allocating a descriptor per frame, or attaches
//     `timestampWrites` while the profiler is off.
// WebGL has no FFT compute chain, so there is no twin to keep in step.
//
// Run: node --test Tools/visual-regression/ocean-compute-pass-timestamp.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecordingDevice,
  loadOceanRenderer,
  makeOceanFrameState,
  makeOceanPrimitive,
} from "./lib/ocean-fft-device-harness.mjs";

const OCEAN_PASS_LABEL = "Ocean FFT single-pass compute chain";
const FRAMES = 4;
const RENDERER_SUFFIX = "/Renderer/WebGPU/WebGPUOceanRenderer.ts";

/**
 * A stand-in for WebGPUPerformanceManager.withComputePassTimestamps: when armed
 * it registers the pass by label and returns a copy carrying timestampWrites,
 * otherwise it returns the descriptor object unchanged.
 */
function makeAccessor(armed, registered) {
  return (descriptor) => {
    if (!armed) {
      return descriptor;
    }
    registered.push(descriptor.label);
    return {
      ...descriptor,
      timestampWrites: {
        querySet: { label: "pass timestamps" },
        beginningOfPassWriteIndex: registered.length * 2 - 2,
        endOfPassWriteIndex: registered.length * 2 - 1,
      },
    };
  };
}

/**
 * Runs FRAMES renderer updates on a context whose accessor is `mode`: "armed",
 * "unarmed" (accessor returns the descriptor) or "absent" (no accessor).
 */
async function runScenario({ mode, useFrameEncoder, transform }) {
  const api = await loadOceanRenderer(transform ? { transform } : undefined);
  const { device, log } = createRecordingDevice();
  const prim = makeOceanPrimitive();
  const registered = [];
  for (let i = 0; i < FRAMES; i++) {
    log.beginFrame(i);
    const frameState = makeOceanFrameState(device, {
      frameNumber: i,
      seconds: i / 60,
      useFrameEncoder,
    });
    if (mode !== "absent") {
      frameState.context.withComputePassTimestamps = makeAccessor(
        mode === "armed",
        registered,
      );
    }
    api.updateWebGPUOcean(prim, frameState);
    await new Promise((done) => setImmediate(done));
  }
  api.destroyWebGPUOceanResources(prim);
  return {
    registered,
    passes: log.computePasses,
    dispatches: log.dispatches.map((d) => ({
      frame: d.frame,
      entryPoint: d.entryPoint,
      moduleLabel: d.moduleLabel,
      workgroups: d.workgroups,
    })),
  };
}

// The first frame only builds the async pipelines and opens no pass, so the
// number of passes is read from the log: it must be at least one, never two in
// a frame, and (armed) equal to the number of registrations.
function checkOnePassPerFrame(run) {
  assert.ok(run.passes.length >= 1, "the chain ran at least once");
  const frames = run.passes.map((pass) => pass.frame);
  assert.equal(new Set(frames).size, frames.length, "one pass per frame");
}

function checkArmed(run) {
  checkOnePassPerFrame(run);
  assert.deepEqual(
    run.registered,
    Array(run.passes.length).fill(OCEAN_PASS_LABEL),
    "exactly one ocean pass is registered per pass, under the PF-2 label",
  );
  run.passes.forEach((pass, i) => {
    assert.equal(pass.descriptor.label, OCEAN_PASS_LABEL);
    assert.deepEqual(
      pass.descriptor.timestampWrites,
      {
        querySet: { label: "pass timestamps" },
        beginningOfPassWriteIndex: i * 2,
        endOfPassWriteIndex: i * 2 + 1,
      },
      `frame ${i} carries the timestampWrites the context returned`,
    );
  });
}

function checkDefaultPath(run) {
  assert.deepEqual(run.registered, [], "nothing is registered");
  checkOnePassPerFrame(run);
  for (const pass of run.passes) {
    assert.equal(pass.descriptor.label, OCEAN_PASS_LABEL);
    assert.equal(
      Object.hasOwn(pass.descriptor, "timestampWrites"),
      false,
      "no timestampWrites while the profiler is off",
    );
    assert.equal(
      pass.descriptor,
      run.passes[0].descriptor,
      "the same descriptor object every frame",
    );
  }
  assert.ok(Object.isFrozen(run.passes[0].descriptor));
}

const ENCODERS = [
  ["with a frame encoder", true],
  ["with a private encoder", false],
];

for (const [name, useFrameEncoder] of ENCODERS) {
  test(`armed profiler ${name}: the ocean pass carries timestampWrites and registers once per frame`, async () => {
    checkArmed(await runScenario({ mode: "armed", useFrameEncoder }));
  });

  test(`unarmed profiler ${name}: the descriptor is the unchanged frozen constant`, async () => {
    checkDefaultPath(await runScenario({ mode: "unarmed", useFrameEncoder }));
  });

  test(`context without the accessor ${name}: the descriptor is the unchanged frozen constant`, async () => {
    checkDefaultPath(await runScenario({ mode: "absent", useFrameEncoder }));
  });

  test(`dispatch sequence ${name}: identical armed, unarmed and without the accessor`, async () => {
    const armed = await runScenario({ mode: "armed", useFrameEncoder });
    const unarmed = await runScenario({ mode: "unarmed", useFrameEncoder });
    const absent = await runScenario({ mode: "absent", useFrameEncoder });
    assert.ok(armed.dispatches.length > 0, "the chain dispatched something");
    assert.deepEqual(armed.dispatches, unarmed.dispatches);
    assert.deepEqual(absent.dispatches, unarmed.dispatches);
  });
}

// Inertness: the helper call made unreachable, so the slot is never requested.
const NEVER_ASK = (path, text) => {
  if (!path.endsWith(RENDERER_SUFFIX)) {
    return text;
  }
  const anchor = "context.withComputePassTimestamps?.(";
  assert.equal(text.split(anchor).length, 2, "the helper call occurs once");
  return text.replace(
    anchor,
    () => "(false ? context.withComputePassTimestamps : undefined)?.(",
  );
};

for (const [name, useFrameEncoder] of ENCODERS) {
  test(`inertness ${name}: a renderer that never asks for timestamp writes turns the armed check red and leaves the default checks green`, async () => {
    checkArmed(await runScenario({ mode: "armed", useFrameEncoder }));
    const mutantArmed = await runScenario({
      mode: "armed",
      useFrameEncoder,
      transform: NEVER_ASK,
    });
    assert.throws(() => checkArmed(mutantArmed), assert.AssertionError);
    assert.deepEqual(mutantArmed.registered, []);
    checkDefaultPath(
      await runScenario({
        mode: "unarmed",
        useFrameEncoder,
        transform: NEVER_ASK,
      }),
    );
    checkDefaultPath(
      await runScenario({
        mode: "absent",
        useFrameEncoder,
        transform: NEVER_ASK,
      }),
    );
    const unmutated = await runScenario({ mode: "unarmed", useFrameEncoder });
    assert.deepEqual(
      mutantArmed.dispatches,
      unmutated.dispatches,
      "the dispatch sequence does not depend on the helper call",
    );
  });
}
