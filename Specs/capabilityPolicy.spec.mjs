// Node-level checks for the spec-level host-capability lane
// (`Specs/capabilityPolicy.js`). Run with:
//
//   node --test Specs/capabilityPolicy.spec.mjs
//
// A browser run only ever shows the branch its host takes, so every branch -
// present, missing, probe throws, demanded, filtered out - is driven here over
// a fake Jasmine scope.
import assert from "node:assert/strict";
import test from "node:test";

import {
  Capability,
  CAPABILITY_LANE_SUMMARY_PREFIX,
  createCapabilityLaneRunSummary,
  demandedCapabilities,
  installCapabilityLaneRunReport,
  installCapabilityLaneSpecLedger,
  itRequiresCapability,
  probeCapability,
  REQUIRE_CAPABILITIES_ARGUMENT,
  setCapabilityLane,
} from "./capabilityPolicy.js";

class PendingSignal extends Error {}

// A minimal Jasmine: `it` records specs; `run` executes them in order, maps a
// thrown PendingSignal to "pending" and anything else to "failed", then fires
// every reporter's specDone and every afterAll in reverse order.
function fakeJasmine({ webgl, gpu, demanded = [], excluded = [] } = {}) {
  const specs = [];
  const reporters = [];
  const afterAlls = [];
  const reports = [];
  let getContextCalls = 0;
  const scope = {
    console: { info() {} },
    it(description, fn) {
      const spec = { id: `spec${specs.length}`, description, fn };
      specs.push(spec);
      return {
        id: spec.id,
        description,
        getFullName: () => `Suite ${description}`,
      };
    },
    pending(message) {
      throw new PendingSignal(message);
    },
  };
  if (webgl !== undefined) {
    scope.WebGLRenderingContext = function () {};
    scope.WebGL2RenderingContext = function () {};
    scope.document = {
      createElement(tag) {
        assert.equal(tag, "canvas");
        return {
          getContext(type, attributes) {
            getContextCalls += 1;
            assert.equal(type, "webgl2");
            assert.deepEqual(attributes, {
              alpha: false,
              stencil: true,
              powerPreference: "high-performance",
            });
            if (webgl === "throws") {
              throw new Error("context creation blocked");
            }
            return webgl === "present"
              ? { getExtension: () => ({ loseContext() {} }) }
              : null;
          },
        };
      },
    };
  }
  scope.navigator = gpu ? { gpu: {} } : {};

  const env = {
    addReporter(reporter) {
      reporters.push(reporter);
    },
    afterAll(fn) {
      afterAlls.push(fn);
    },
  };
  setCapabilityLane({ demanded }, scope);
  installCapabilityLaneSpecLedger(env, scope);
  installCapabilityLaneRunReport(env, {
    scope,
    report: (message) => reports.push(message),
  });

  async function run() {
    const results = [];
    for (const spec of specs) {
      let status;
      let error;
      if (excluded.includes(spec.description)) {
        status = "excluded";
      } else {
        try {
          await (spec.fn.length > 0
            ? new Promise((resolve, reject) => {
                const out = spec.fn.call({}, resolve);
                if (out && typeof out.then === "function") {
                  out.then(undefined, reject);
                }
              })
            : spec.fn.call({}));
          status = "passed";
        } catch (e) {
          status = e instanceof PendingSignal ? "pending" : "failed";
          error = e;
        }
      }
      for (const reporter of reporters) {
        reporter.specDone({
          id: spec.id,
          fullName: `Suite ${spec.description}`,
          status,
        });
      }
      results.push({ description: spec.description, status, error });
    }
    for (const fn of [...afterAlls].reverse()) {
      fn();
    }
    return results;
  }

  return { scope, run, reports, getContextCalls: () => getContextCalls };
}

test("a present capability runs the body and reports it executed", async () => {
  const harness = fakeJasmine({ webgl: "present", gpu: true });
  let ran = 0;
  itRequiresCapability(
    Capability.REAL_WEBGL,
    "webgl spec",
    () => (ran += 1),
    undefined,
    harness.scope,
  );
  itRequiresCapability(
    Capability.WEBGPU_API,
    "webgpu spec",
    async () => (ran += 1),
    undefined,
    harness.scope,
  );
  const results = await harness.run();
  assert.deepEqual(
    results.map((r) => r.status),
    ["passed", "passed"],
  );
  assert.equal(ran, 2);
  assert.equal(harness.reports.length, 1);
  assert.ok(harness.reports[0].startsWith(CAPABILITY_LANE_SUMMARY_PREFIX));
  const summary = JSON.parse(
    harness.reports[0].slice(CAPABILITY_LANE_SUMMARY_PREFIX.length),
  );
  assert.equal(summary.executedSpecCount, 2);
  assert.equal(summary.skippedSpecCount, 0);
  assert.deepEqual(summary.skippedSpecs, []);
});

test("a missing real WebGL context skips the spec, never runs its body, and names the reason in the report", async () => {
  const harness = fakeJasmine({ webgl: "null", gpu: true });
  let ran = false;
  itRequiresCapability(
    Capability.REAL_WEBGL,
    "webgl spec",
    async () => {
      ran = true;
    },
    undefined,
    harness.scope,
  );
  const [result] = await harness.run();
  assert.equal(result.status, "pending");
  assert.equal(ran, false);
  const reason =
    'requires a real WebGL context: canvas.getContext("webgl2") returned null';
  assert.equal(result.error.message, reason);
  const summary = JSON.parse(
    harness.reports[0].slice(CAPABILITY_LANE_SUMMARY_PREFIX.length),
  );
  assert.deepEqual(summary.skippedSpecs, [
    { name: "Suite webgl spec", capability: Capability.REAL_WEBGL, reason },
  ]);
  assert.equal(summary.executedSpecCount, 0);
});

test("a probe that throws is a missing capability whose reason carries the thrown message", async () => {
  const harness = fakeJasmine({ webgl: "throws", gpu: true });
  itRequiresCapability(
    Capability.REAL_WEBGL,
    "webgl spec",
    () => {},
    undefined,
    harness.scope,
  );
  const [result] = await harness.run();
  assert.equal(result.status, "pending");
  assert.match(
    result.error.message,
    /getContext\("webgl2"\) threw: context creation blocked/,
  );
});

test("a host with no WebGLRenderingContext is missing with that reason", async () => {
  const harness = fakeJasmine({ gpu: true });
  itRequiresCapability(
    Capability.REAL_WEBGL,
    "webgl spec",
    () => {},
    undefined,
    harness.scope,
  );
  const [result] = await harness.run();
  assert.equal(result.status, "pending");
  assert.match(result.error.message, /defines no WebGLRenderingContext/);
});

test("a missing WebGPU implementation skips with a named reason", async () => {
  const harness = fakeJasmine({ webgl: "present", gpu: false });
  itRequiresCapability(
    Capability.WEBGPU_API,
    "webgpu spec",
    () => {},
    undefined,
    harness.scope,
  );
  const [result] = await harness.run();
  assert.equal(result.status, "pending");
  assert.equal(
    result.error.message,
    "requires a WebGPU implementation: navigator.gpu is absent",
  );
});

test("a demanded capability that is missing FAILS the spec instead of skipping it", async () => {
  const harness = fakeJasmine({
    webgl: "null",
    gpu: false,
    demanded: [Capability.REAL_WEBGL, Capability.WEBGPU_API],
  });
  itRequiresCapability(
    Capability.REAL_WEBGL,
    "webgl spec",
    () => {},
    undefined,
    harness.scope,
  );
  itRequiresCapability(
    Capability.WEBGPU_API,
    "webgpu spec",
    () => {},
    undefined,
    harness.scope,
  );
  const results = await harness.run();
  assert.deepEqual(
    results.map((r) => r.status),
    ["failed", "failed"],
  );
  assert.match(
    results[0].error.message,
    /"real-webgl" was demanded but is missing: requires a real WebGL context/,
  );
  assert.match(
    results[1].error.message,
    /"webgpu-api" was demanded but is missing: requires a WebGPU implementation/,
  );
  const summary = JSON.parse(
    harness.reports[0].slice(CAPABILITY_LANE_SUMMARY_PREFIX.length),
  );
  assert.equal(summary.failedSpecCount, 2);
});

test("a capability forced present on a host without it runs the body, so the body's own failure is loud", async () => {
  const harness = fakeJasmine({ webgl: "null", gpu: true });
  probeCapability(Capability.WEBGPU_API, harness.scope);
  harness.scope.__cesiumCapabilityProbes[Capability.REAL_WEBGL] = {
    capability: Capability.REAL_WEBGL,
    available: true,
    reason: null,
  };
  itRequiresCapability(
    Capability.REAL_WEBGL,
    "webgl spec",
    async () => {
      throw new Error("The browser supports WebGL, but initialization failed.");
    },
    undefined,
    harness.scope,
  );
  const [result] = await harness.run();
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /initialization failed/);
});

test("the probe runs once per page however many specs need it", async () => {
  const harness = fakeJasmine({ webgl: "null", gpu: true });
  for (let i = 0; i < 3; i++) {
    itRequiresCapability(
      Capability.REAL_WEBGL,
      `webgl spec ${i}`,
      () => {},
      undefined,
      harness.scope,
    );
  }
  await harness.run();
  assert.equal(harness.getContextCalls(), 1);
  const summary = createCapabilityLaneRunSummary(harness.scope);
  assert.equal(summary.skippedSpecCount, 3);
  assert.equal(summary.probes.length, 1);
});

test("a run that filtered every capability spec out does not probe and stays silent", async () => {
  const harness = fakeJasmine({
    webgl: "null",
    gpu: true,
    excluded: ["webgl spec"],
  });
  itRequiresCapability(
    Capability.REAL_WEBGL,
    "webgl spec",
    () => {},
    undefined,
    harness.scope,
  );
  await harness.run();
  assert.equal(harness.getContextCalls(), 0);
  assert.deepEqual(harness.reports, []);
});

test("a done-style body keeps its arity and receives done", async () => {
  const harness = fakeJasmine({ webgl: "present", gpu: true });
  let received;
  itRequiresCapability(
    Capability.REAL_WEBGL,
    "done spec",
    (done) => {
      received = typeof done;
      done();
    },
    undefined,
    harness.scope,
  );
  const [result] = await harness.run();
  assert.equal(result.status, "passed");
  assert.equal(received, "function");
});

test("an unknown capability is a declaration error, not a skip", () => {
  const harness = fakeJasmine({ webgl: "present", gpu: true });
  assert.throws(
    () =>
      itRequiresCapability(
        "real-webgll",
        "typo",
        () => {},
        undefined,
        harness.scope,
      ),
    /unknown capability "real-webgll"/,
  );
});

test("the demand is read by token from the karma args, and the WebGPU Scene lane demands the WebGPU API", () => {
  assert.deepEqual(demandedCapabilities(undefined), []);
  assert.deepEqual(
    demandedCapabilities(["", "", false, true, false, 0, 0, "--grep", "x"]),
    [],
  );
  assert.deepEqual(
    demandedCapabilities(["--grep", "x", REQUIRE_CAPABILITIES_ARGUMENT]).sort(),
    [Capability.REAL_WEBGL, Capability.WEBGPU_API].sort(),
  );
  assert.deepEqual(demandedCapabilities([], { webgpuDemanded: true }), [
    Capability.WEBGPU_API,
  ]);
});
