// @purpose Prevents quiet settle windows from being reported as completed demos.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import {
  EVALUATE_TIMEOUT,
  buildSandcastle2Url,
  evaluateFrameGate,
  evaluateRendererGate,
  evaluateWithDeadline,
  readRendererStateInPage,
} from "./lib/sandcastle2-renderer-gate.mjs";
import {
  computeSandcastle2Origins,
  OriginRewriteRefusal,
} from "./lib/sandcastle2-origin-rewrite.mjs";

const source = fs.readFileSync(
  new URL("./sandcastle-smoke.mjs", import.meta.url),
  "utf8",
);
const start = source.indexOf("async function readDemoReadinessInPage(");
const end = source.indexOf("async function writeSweepReport(", start);
assert.ok(start > 0 && end > start);

async function runStub({
  settle = 40,
  ready,
  renderer = "webgpu",
  frameNumber = 50,
  mutate = (s) => s,
} = {}) {
  let elapsed = 0;
  let emitted = 0;
  let closed = 0;
  const handlers = new Map();
  const failAt = settle + 1000;
  const advance = (ms) => {
    elapsed += ms;
    if (elapsed >= failAt && emitted === 0) {
      emitted++;
      handlers.get("pageerror")?.(new Error("delayed demo fault"));
    }
  };
  const page = {
    setDefaultTimeout() {},
    addInitScript: async () => {},
    on: (event, callback) => handlers.set(event, callback),
    waitForTimeout: async (ms) => advance(ms),
    close: async () => {
      closed++;
    },
  };
  const context = {
    exposeBinding: async () => {},
    close: async () => {
      closed++;
    },
  };
  const globals = {
    Cesium: {
      GraphicsContext: {
        registry: {
          all: new Map([["one", { id: "one", rendererType: renderer }]]),
        },
      },
    },
    __sandcastleInstances: [{ scene: { frameState: { frameNumber } } }],
    __sandcastleSmokeReady: ready,
  };
  const frame = {
    evaluate: (fn) => vm.runInNewContext("(" + fn.toString() + ")()", globals),
    $: async () => null,
  };
  const run = vm.runInNewContext(
    mutate(source.slice(start, end)) + "\nrunSweepDemoBody;",
    {
      URL,
      path,
      BASE: "http://localhost:8096",
      SANDCASTLE2_BUCKET_BASE: "http://localhost:8097",
      SWEEP_OUTPUT_DIR: "unused",
      NAV_TIMEOUT_MS: 1000,
      SETTLE_MS: settle,
      EVALUATE_TIMEOUT_MS: 20,
      computeSandcastle2Origins,
      OriginRewriteRefusal,
      createGuardedPage: async () => page,
      openSandcastle2Url: async () => ({ bucketFrame: frame }),
      attachConsoleErrorGate: () => [],
      collectGateErrors: async () => ({ errors: [], deviceLost: null }),
      SUPPRESSED_CONSOLE: [],
      isExternalResourceFailure: () => false,
      errorGateInit: () => {},
      isNoViewerId: () => false,
      buildSandcastle2Url,
      EVALUATE_TIMEOUT,
      evaluateFrameGate,
      evaluateRendererGate,
      evaluateWithDeadline,
      readRendererStateInPage,
    },
  );
  const result = await run(
    { newContext: async () => context },
    "late-fault",
    { renderer: "webgpu" },
    { lastFrameNumber: null },
  );
  return { result, advance, emitted: () => emitted, closed };
}

async function assertLateFaultIsNotPass(settle, mutate) {
  const fixture = await runStub({ settle, mutate });
  assert.equal(
    fixture.emitted(),
    0,
    "the fault is beyond the complete observation window",
  );
  assert.equal(
    fixture.result.ok,
    false,
    "quiet observation does not prove demo completion",
  );
  assert.equal(fixture.result.outcome, "FAIL");
  assert.match(fixture.result.errors[0], /INCONCLUSIVE/);
  assert.equal(fixture.closed, 2);
  fixture.advance(1001);
  assert.equal(fixture.emitted(), 1, "the stub really has a delayed failure");
}

for (const settle of [40, 80]) {
  test(
    "a fault after the " + settle + "ms settle window cannot earn PASS",
    () => assertLateFaultIsNotPass(settle),
  );
}

test("the late-fault assertion rejects the old quiet-window verdict", async () => {
  await assert.rejects(
    assertLateFaultIsNotPass(40, (text) => {
      const anchor = 'return ready === true ? "PASS" : "INCONCLUSIVE";';
      assert.equal(text.split(anchor).length - 1, 1);
      return text.replace(anchor, 'return "PASS";');
    }),
    /quiet observation does not prove demo completion/,
  );
});

test("a declared completion predicate and healthy gates can earn PASS", async () => {
  let called = 0;
  const { result } = await runStub({
    ready: async () => {
      called++;
      return true;
    },
  });
  assert.equal(called, 1);
  assert.equal(result.outcome, "PASS");
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result), [
    "id",
    "url",
    "outcome",
    "ok",
    "timedOut",
    "expectNoViewer",
    "rendererGate",
    "frameGate",
    "errors",
    "suppressedCount",
    "pngPath",
  ]);
});

test("a false completion predicate is inconclusive", async () => {
  const { result } = await runStub({ ready: () => false });
  assert.equal(result.outcome, "FAIL");
  assert.match(result.errors[0], /INCONCLUSIVE/);
});

test("a boolean flag is not a demo completion predicate", async () => {
  const { result } = await runStub({ ready: true });
  assert.equal(result.outcome, "FAIL");
  assert.match(result.errors[0], /INCONCLUSIVE/);
});

test("a declared predicate that throws is a failure", async () => {
  const { result } = await runStub({
    ready: () => {
      throw new Error("completion failed");
    },
  });
  assert.equal(result.outcome, "FAIL");
  assert.match(result.errors[0], /completion failed/);
});

test("a declared predicate that never settles is a timeout", async () => {
  const { result } = await runStub({ ready: () => new Promise(() => {}) });
  assert.equal(result.outcome, "TIMEOUT");
  assert.equal(result.timedOut, true);
});

test("completion evidence cannot override a wrong backend or stopped frame loop", async () => {
  for (const options of [{ renderer: "webgl" }, { frameNumber: 0 }]) {
    const { result } = await runStub({ ...options, ready: () => true });
    assert.equal(result.outcome, "FAIL");
    assert.equal(result.ok, false);
  }
});
