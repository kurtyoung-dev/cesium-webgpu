// Node-level checks for the Scene-level WebGPU spec lane
// (`Specs/webgpuPolicy.js`). Run with:
//
//   node --test Specs/webgpuPolicy.spec.mjs
//
// These exist because the lane's VALUE is entirely in its failure paths, and a
// browser run can only ever demonstrate the passing one: a green Karma run
// proves the lane executed, never that it would have failed had it not. Every
// exported function takes an explicit `scope`, so the whole policy — including
// the fail-closed root hook — is exercisable without a DOM or a GPU.
//
// The adapter fixtures below are MEASURED, not invented. They are the literal
// `GPUAdapterInfo` payloads read from Edge 151.0.4129.93 launched with the
// flag set in `Specs/karma.conf.cjs` (`EdgeHeadlessCI`), with and without
// `--disable-gpu` added.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AdapterTier,
  classifyAdapterTier,
  createWebGPULaneRunSummary,
  describeRequiresWebGPU,
  installWebGPULaneRunAssertion,
  installWebGPULaneSpecLedger,
  recordWebGPUAdapterTier,
  RequiredAdapterTier,
  setWebGPULane,
  WEBGPU_LANE_SKIP_REASON,
  WEBGPU_LANE_SUMMARY_PREFIX,
  WEBGPU_STUB_LANE_SKIP_REASON,
  webgpuLaneFailureMessage,
} from "./webgpuPolicy.js";

/** Measured: Karma's EdgeHeadlessCI flag set, unmodified. */
const HARDWARE_ADAPTER_INFO = {
  vendor: "nvidia",
  architecture: "pascal",
  device: "",
  description: "",
  isFallbackAdapter: false,
};

/** Measured: the same flag set plus `--disable-gpu`. Still an adapter. */
const SWIFTSHADER_ADAPTER_INFO = {
  vendor: "google",
  architecture: "swiftshader",
  device: "",
  description: "",
  isFallbackAdapter: true,
};

function createScope(options = {}) {
  const scope = {
    describe: (name) => scope.describeCalls.push(name),
    xdescribe: (name) => scope.xdescribeCalls.push(name),
    describeCalls: [],
    xdescribeCalls: [],
  };
  if (options.webgpu !== false) {
    scope.navigator = { gpu: {} };
  } else {
    scope.navigator = {};
  }
  if (options.webglStub === true) {
    scope.webglStub = true;
  }
  return scope;
}

/** Minimal Jasmine env stand-in that captures what was installed. */
function createEnv() {
  const env = {
    reporters: [],
    afterAllCallbacks: [],
    addReporter: (reporter) => env.reporters.push(reporter),
    afterAll: (callback) => env.afterAllCallbacks.push(callback),
  };
  return env;
}

test("classifyAdapterTier reads the measured hardware adapter as hardware", () => {
  assert.equal(
    classifyAdapterTier(HARDWARE_ADAPTER_INFO),
    AdapterTier.HARDWARE,
  );
});

test("classifyAdapterTier reads the measured --disable-gpu adapter as software", () => {
  assert.equal(
    classifyAdapterTier(SWIFTSHADER_ADAPTER_INFO),
    AdapterTier.SOFTWARE,
  );
});

test("classifyAdapterTier catches software rasterizers that set no fallback flag", () => {
  // Mesa's llvmpipe / lavapipe are genuine software devices that are not
  // necessarily reported as fallback adapters, which is why the name check is
  // an independent net rather than a duplicate of `isFallbackAdapter`.
  for (const architecture of ["llvmpipe", "lavapipe", "SwiftShader"]) {
    assert.equal(
      classifyAdapterTier({ vendor: "mesa", architecture }),
      AdapterTier.SOFTWARE,
      `${architecture} must classify as software`,
    );
  }
});

test("classifyAdapterTier honours isFallbackAdapter on its own", () => {
  // Pins the flag net INDEPENDENTLY of the name net. The measured SwiftShader
  // payload trips both, so it cannot tell them apart: deleting the flag check
  // leaves that fixture classified correctly by name alone. A fallback adapter
  // is not obliged to advertise a software-sounding name, and this is the
  // shape that would then be waved through as hardware.
  assert.equal(
    classifyAdapterTier({
      vendor: "nvidia",
      architecture: "pascal",
      isFallbackAdapter: true,
    }),
    AdapterTier.SOFTWARE,
  );
});

test("classifyAdapterTier reports an uninformative adapter as unknown, never hardware", () => {
  assert.equal(classifyAdapterTier(undefined), AdapterTier.UNKNOWN);
  assert.equal(classifyAdapterTier(null), AdapterTier.UNKNOWN);
  assert.equal(classifyAdapterTier({}), AdapterTier.UNKNOWN);
  assert.equal(
    classifyAdapterTier({
      vendor: "",
      architecture: "",
      device: "",
      description: "",
    }),
    AdapterTier.UNKNOWN,
  );
});

test("describeRequiresWebGPU skips truthfully when the host exposes no WebGPU", () => {
  const scope = createScope({ webgpu: false });
  setWebGPULane({}, scope);
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);

  assert.deepEqual(scope.describeCalls, []);
  assert.deepEqual(scope.xdescribeCalls, ["Scene/Example"]);

  const summary = createWebGPULaneRunSummary(scope);
  assert.equal(summary.declaredSuiteCount, 1);
  assert.deepEqual(summary.skippedSuites, [
    { name: "Scene/Example", reason: WEBGPU_LANE_SKIP_REASON },
  ]);
});

test("describeRequiresWebGPU skips the WebGL stub lane with its own reason", () => {
  const scope = createScope({ webglStub: true });
  setWebGPULane({}, scope);
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);

  assert.deepEqual(scope.xdescribeCalls, ["Scene/Example"]);
  assert.equal(
    createWebGPULaneRunSummary(scope).skippedSuites[0].reason,
    WEBGPU_STUB_LANE_SKIP_REASON,
  );
});

test("describeRequiresWebGPU runs the suite when WebGPU is present", () => {
  const scope = createScope();
  setWebGPULane({}, scope);
  describeRequiresWebGPU("Scene/Example", () => {}, "WebGL", scope);

  assert.deepEqual(scope.describeCalls, ["Scene/Example"]);
  assert.deepEqual(scope.xdescribeCalls, []);
  assert.equal(createWebGPULaneRunSummary(scope).skippedSuiteCount, 0);
});

test("a demanded lane defaults to requiring hardware", () => {
  const scope = createScope();
  setWebGPULane({ demanded: true }, scope);
  assert.equal(
    createWebGPULaneRunSummary(scope).requiredTier,
    RequiredAdapterTier.HARDWARE,
  );
});

test("the spec ledger counts executed specs but NOT pending ones", () => {
  // This is the trap the ledger exists to close: a spec that calls `pending()`
  // in its body has already run its `beforeEach` hooks, so any hook-based tally
  // would score it as coverage. Jasmine reports it as `pending` at specDone.
  const scope = createScope();
  setWebGPULane({ demanded: true }, scope);
  const env = createEnv();
  installWebGPULaneSpecLedger(env, scope);
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);

  const [reporter] = env.reporters;
  reporter.specDone({
    fullName: "Scene/Example does a thing",
    status: "pending",
  });
  reporter.specDone({
    fullName: "Scene/Example does another",
    status: "excluded",
  });
  reporter.specDone({ fullName: "Other/Suite unrelated", status: "passed" });

  const summary = createWebGPULaneRunSummary(scope);
  assert.equal(summary.executedSpecCount, 0);
  assert.equal(summary.skippedSpecCount, 2);

  reporter.specDone({
    fullName: "Scene/Example finally runs",
    status: "passed",
  });
  reporter.specDone({ fullName: "Scene/Example fails", status: "failed" });
  const after = createWebGPULaneRunSummary(scope);
  assert.equal(after.executedSpecCount, 2);
  assert.equal(after.failedSpecCount, 1);
});

test("an undemanded lane that never ran is not a failure", () => {
  const scope = createScope({ webgpu: false });
  setWebGPULane({}, scope);
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);
  assert.equal(
    webgpuLaneFailureMessage(createWebGPULaneRunSummary(scope)),
    null,
  );
});

test("a DEMANDED lane that never ran fails, naming the reason", () => {
  const scope = createScope({ webgpu: false });
  setWebGPULane({ demanded: true }, scope);
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);

  const message = webgpuLaneFailureMessage(createWebGPULaneRunSummary(scope));
  assert.ok(message, "a demanded lane with zero executed specs must fail");
  assert.match(message, /ZERO WebGPU specs executed/);
  assert.match(message, /Scene\/Example \(requires a WebGPU adapter\)/);
});

test("a DEMANDED lane with no declared suite at all fails", () => {
  const scope = createScope();
  setWebGPULane({ demanded: true }, scope);
  const message = webgpuLaneFailureMessage(createWebGPULaneRunSummary(scope));
  assert.ok(message);
  assert.match(message, /no suite was declared with describeRequiresWebGPU/);
});

test("a hardware lane REJECTS the measured SwiftShader adapter", () => {
  const scope = createScope();
  setWebGPULane({ demanded: true }, scope);
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);
  recordAnExecutedSpec(scope);
  recordWebGPUAdapterTier(SWIFTSHADER_ADAPTER_INFO, scope);

  const message = webgpuLaneFailureMessage(createWebGPULaneRunSummary(scope));
  assert.ok(message, "software must not satisfy a hardware lane");
  assert.match(message, /hardware was required/);
  assert.match(message, /swiftshader/);
});

test("a hardware lane ACCEPTS the measured hardware adapter", () => {
  const scope = createScope();
  setWebGPULane({ demanded: true }, scope);
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);
  recordAnExecutedSpec(scope);
  recordWebGPUAdapterTier(HARDWARE_ADAPTER_INFO, scope);

  assert.equal(
    webgpuLaneFailureMessage(createWebGPULaneRunSummary(scope)),
    null,
  );
});

test("--webgpu-tier=any accepts a software adapter but still records the tier", () => {
  const scope = createScope();
  setWebGPULane(
    { demanded: true, requiredTier: RequiredAdapterTier.ANY },
    scope,
  );
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);
  recordAnExecutedSpec(scope);
  recordWebGPUAdapterTier(SWIFTSHADER_ADAPTER_INFO, scope);

  const summary = createWebGPULaneRunSummary(scope);
  assert.equal(webgpuLaneFailureMessage(summary), null);
  assert.equal(summary.adapterTier, AdapterTier.SOFTWARE);
});

test("a hardware lane that executed but never recorded a tier fails closed", () => {
  const scope = createScope();
  setWebGPULane({ demanded: true }, scope);
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);
  recordAnExecutedSpec(scope);

  const message = webgpuLaneFailureMessage(createWebGPULaneRunSummary(scope));
  assert.ok(message);
  assert.match(message, /never\s+recorded an adapter tier/);
});

test("an unknown-tier adapter cannot satisfy a hardware lane", () => {
  const scope = createScope();
  setWebGPULane({ demanded: true }, scope);
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);
  recordAnExecutedSpec(scope);
  recordWebGPUAdapterTier({}, scope);

  const message = webgpuLaneFailureMessage(createWebGPULaneRunSummary(scope));
  assert.ok(message, '"we could not tell" must not become "allowed"');
  assert.match(message, /classified as "unknown"/);
});

test("the installed root afterAll reports on every declaring run and throws when demanded", () => {
  // The hook, not just the predicate: this is the code path customizeJasmine
  // actually wires in.
  const scope = createScope({ webgpu: false });
  setWebGPULane({ demanded: true }, scope);
  const env = createEnv();
  const reported = [];
  installWebGPULaneRunAssertion(env, {
    scope,
    report: (message) => reported.push(message),
  });
  describeRequiresWebGPU("Scene/Example", () => {}, undefined, scope);

  assert.equal(env.afterAllCallbacks.length, 1);
  assert.throws(env.afterAllCallbacks[0], /ZERO WebGPU specs executed/);
  assert.equal(reported.length, 1, "the summary is emitted before the throw");
  assert.ok(reported[0].startsWith(WEBGPU_LANE_SUMMARY_PREFIX));
  // The summary must be machine-readable; CI extracts it by prefix.
  const payload = JSON.parse(
    reported[0].slice(WEBGPU_LANE_SUMMARY_PREFIX.length),
  );
  assert.equal(payload.demanded, true);
  assert.equal(payload.executedSpecCount, 0);
  assert.equal(payload.skippedSuiteCount, 1);
});

test("the root afterAll stays silent for a run with no lane at all", () => {
  const scope = createScope();
  setWebGPULane({}, scope);
  const env = createEnv();
  const reported = [];
  installWebGPULaneRunAssertion(env, {
    scope,
    report: (message) => reported.push(message),
  });

  env.afterAllCallbacks[0]();
  assert.deepEqual(reported, []);
});

test("the run summary is deterministic regardless of declaration order", () => {
  const first = createScope({ webgpu: false });
  setWebGPULane({}, first);
  describeRequiresWebGPU("Scene/B", () => {}, undefined, first);
  describeRequiresWebGPU("Scene/A", () => {}, undefined, first);

  const second = createScope({ webgpu: false });
  setWebGPULane({}, second);
  describeRequiresWebGPU("Scene/A", () => {}, undefined, second);
  describeRequiresWebGPU("Scene/B", () => {}, undefined, second);

  assert.deepEqual(
    createWebGPULaneRunSummary(first),
    createWebGPULaneRunSummary(second),
  );
});

/** Drives one passing spec through a real ledger reporter. */
function recordAnExecutedSpec(scope) {
  const env = createEnv();
  installWebGPULaneSpecLedger(env, scope);
  env.reporters[0].specDone({
    fullName: "Scene/Example runs",
    status: "passed",
  });
}
