// sandcastle2-demo-capture.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Drives lib/sandcastle2-demo-capture.mjs on a stubbed page, run frame and open/capture/driver seams and asserts its contract: the CAPTURED shape and the exact record keys, the capture taken on the run frame with the scene-canvas selector, the origin-port-plus-one run-frame default, the three NOT_RUN: ion cases (ion declared unavailable without opening the page, no token, terrain never leaving the ellipsoid) and that ion is never asked about for a demo that does not need it, the five ProbeRefusal reasons, the TypeErrors of demoCaptureRequest, the purity of decideIonAccess, that the gate read and the arming answer are returned, that a refusal raised after the gate is armed (a settle short of its frames, a clock it could not pin) carries the gate it read or the read's failure while one raised before reads none; and, with the piece's own in-frame functions executed in Node against a fake run frame (the real frame driver and error gate), that the settle counts only frames drawn with the globe's tiles loaded, that the context's init scripts arm a device at the moment the demo requests it, and that the piece arms a device the hook did not see.
// @status ACTIVE
//
// Written from _lane-out/BEHAVIOUR_ALDBURG.md, not from the piece's source.
// The stub frame answers each in-frame call by the SHAPE of what it is asked
// (the renderer-state read by identity, the ion wait by its `timeoutMs`
// argument, the clock pin by `iso`, the settle by `frames`, anything else is
// the device arming), so the spec does not depend on the piece's private
// function names. Every refusal case asserts that `capture` was never reached,
// because a refused or NOT RUN request must leave no picture behind.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProbeRefusal } from "./lib/probe-runtime.mjs";
import {
  SCENE_FRAME_DRIVER_GLOBAL,
  driveSceneFrames,
} from "./lib/probe-scene-frames.mjs";
import {
  NOT_RUN_ION,
  captureSandcastle2Demo,
  decideIonAccess,
  demoCaptureRequest,
  prepareDemoCaptureContext,
} from "./lib/sandcastle2-demo-capture.mjs";
import { readRendererStateInPage } from "./lib/sandcastle2-renderer-gate.mjs";

const OUTPUT_DIRECTORY = path.join(
  os.tmpdir(),
  "cesium-lane",
  "nardol",
  "demo-capture-never-written",
);
const ORIGIN = "http://localhost:8080";
const DEMO_ID = "globe-materials-water-mask-elevation-map";

const RECORD_KEYS = ["demoId", "frames", "ionAccess", "origin", "renderer"];

/**
 * A stub of everything the piece touches. `scenario` overrides the answers.
 * Every seam call lands in `log`, in order.
 */
function makeHarness(scenario = {}) {
  const log = {
    steps: [],
    open: [],
    capture: [],
    drivers: [],
    gates: [],
    breachChecks: 0,
    settle: [],
    ion: [],
    clock: [],
  };
  const settleAnswer = scenario.settle ?? {
    outcome: "done",
    settledFrames: scenario.frames ?? 240,
    frameNumber: 900,
    tilesLoaded: true,
  };
  const frame = {
    tag: "run-frame",
    async waitForFunction() {
      log.steps.push("viewer");
      if (scenario.noViewer) {
        throw new Error("timeout waiting for the viewer");
      }
    },
    async evaluate(fn, arg) {
      if (fn === readRendererStateInPage) {
        log.steps.push("read");
        if (scenario.frameUnreadable) {
          return new Promise(() => {});
        }
        return {
          contexts: scenario.contexts ?? [
            { id: "ctx-1", rendererType: scenario.renderer ?? "webgpu" },
          ],
          frameNumbers: [900],
          note: "",
        };
      }
      if (arg && arg.timeoutMs !== undefined) {
        log.steps.push("ion");
        log.ion.push(arg);
        return (
          scenario.ion ?? {
            tokenPresent: true,
            terrainResolved: true,
            terrainProvider: "CesiumTerrainProvider",
            hasWaterMask: true,
            waitedMs: 5,
          }
        );
      }
      if (arg && arg.iso !== undefined) {
        log.steps.push("clock");
        log.clock.push(arg);
        return (
          scenario.clockAnswer ?? { applied: true, observed: "2026-06-21" }
        );
      }
      if (arg && arg.frames !== undefined) {
        log.steps.push("settle");
        log.settle.push(arg);
        return settleAnswer;
      }
      log.steps.push("arm");
      return { found: 1, armed: 1, gateInstalled: true };
    },
  };
  const page = {
    tag: "top-page",
    context() {
      throw new Error("default-opener-reached");
    },
  };
  const dependencies = {
    async open(openedPage, urlOptions, navigation) {
      log.steps.push("open");
      log.open.push({ page: openedPage, urlOptions, navigation });
      return {
        url: "http://stub/open",
        finalUrl: "http://stub/final",
        bucketFrame: frame,
        bucketFinalUrl: "http://stub/bucket",
        assertNoOriginBreach() {
          log.breachChecks += 1;
        },
      };
    },
    async capture(args) {
      log.steps.push("capture");
      log.capture.push(args);
      return {
        name: args.name,
        path: path.join("relative-out", `${args.name}.png`),
        sha256: "00ff",
        byteLength: 3,
        liveness: { state: "live", frameNumber: 900 },
      };
    },
    async installDriver(target) {
      log.steps.push("driver");
      log.drivers.push(target);
    },
    async readGate(target) {
      log.gates.push(target);
      return { errors: [], deviceLost: null, armedDevices: 1 };
    },
  };
  return { log, frame, page, dependencies };
}

function request(overrides = {}) {
  return {
    origin: ORIGIN,
    demoId: DEMO_ID,
    renderer: "webgpu",
    frames: 240,
    ...overrides,
  };
}

async function run(harness, requestOverrides, depsOverrides = {}) {
  return captureSandcastle2Demo({
    page: harness.page,
    request: request(requestOverrides),
    outputDirectory: OUTPUT_DIRECTORY,
    captures: [],
    dependencies: { ...harness.dependencies, ...depsOverrides },
  });
}

const refusal = (reason) => (error) => {
  assert.ok(
    error instanceof ProbeRefusal,
    `expected a ProbeRefusal, got ${error}`,
  );
  assert.equal(error.reason, reason);
  return true;
};

test("D1: a clean request is CAPTURED with an absolute png and exactly the five record keys", async () => {
  const harness = makeHarness();
  const result = await run(harness);
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.notRun, null);
  assert.ok(path.isAbsolute(result.png), "the png path must be absolute");
  assert.equal(
    result.png,
    path.resolve(path.join("relative-out", `${DEMO_ID}-webgpu.png`)),
  );
  assert.deepEqual(Object.keys(result.record).sort(), RECORD_KEYS);
  assert.equal(result.record.demoId, DEMO_ID);
  assert.equal(result.record.renderer, "webgpu");
  assert.equal(result.record.frames, 240);
  assert.equal(result.record.origin, ORIGIN);
  assert.equal(harness.log.capture.length, 1);
});

test("D1: the capture is taken on the run frame, never the top page, with the scene-canvas selector", async () => {
  const harness = makeHarness();
  await run(harness);
  const [call] = harness.log.capture;
  assert.equal(call.page, harness.frame, "capture must be driven on the frame");
  assert.notEqual(call.page, harness.page, "never on the top page");
  assert.equal(call.selector, ".cesium-widget canvas");
});

test("D1: the demo opens through the open seam as a standalone page with the run frame on port + 1", async () => {
  const harness = makeHarness({ renderer: "webgl" });
  await run(harness, { renderer: "webgl" });
  assert.equal(harness.log.open.length, 1);
  const [{ page, urlOptions }] = harness.log.open;
  assert.equal(page, harness.page);
  assert.equal(urlOptions.standalone, true);
  assert.equal(urlOptions.id, DEMO_ID);
  assert.equal(urlOptions.renderer, "webgl");
  assert.equal(new URL(urlOptions.base).origin, ORIGIN);
  assert.equal(new URL(urlOptions.bucketBase).origin, "http://localhost:8081");
});

test("D1: an explicit bucketOrigin replaces the port + 1 default", async () => {
  const harness = makeHarness();
  await run(harness, { bucketOrigin: "http://localhost:9999" });
  assert.equal(
    new URL(harness.log.open[0].urlOptions.bucketBase).origin,
    "http://localhost:9999",
  );
});

test("D1: with no open seam the default opener is the page-based one (the stub page's context() is reached)", async () => {
  const harness = makeHarness();
  const { open: _open, ...withoutOpen } = harness.dependencies;
  await assert.rejects(
    captureSandcastle2Demo({
      page: harness.page,
      request: request(),
      outputDirectory: OUTPUT_DIRECTORY,
      captures: [],
      dependencies: withoutOpen,
    }),
    /default-opener-reached/,
  );
  assert.equal(harness.log.capture.length, 0);
});

test("D1: the capture comes after the settle, and the settle is asked for the request's frame count", async () => {
  const harness = makeHarness();
  await run(harness, { frames: 120 });
  assert.equal(harness.log.settle.length, 1);
  assert.equal(harness.log.settle[0].frames, 120);
  assert.ok(
    harness.log.steps.indexOf("settle") < harness.log.steps.indexOf("capture"),
    `capture must follow the settle: ${harness.log.steps.join(" > ")}`,
  );
});

test("D2: ion declared unavailable answers NOT_RUN: ion, never opens the page and never captures", async () => {
  const harness = makeHarness();
  const result = await run(harness, { requiresIon: true, ionAvailable: false });
  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.notRun, "NOT_RUN: ion");
  assert.equal(result.notRun, NOT_RUN_ION);
  assert.equal(result.png, null);
  assert.equal(harness.log.open.length, 0, "the page must never be opened");
  assert.equal(harness.log.capture.length, 0);
});

test("D2: a run frame with no ion token answers NOT_RUN: ion and does not capture", async () => {
  const harness = makeHarness({
    ion: {
      tokenPresent: false,
      terrainResolved: true,
      terrainProvider: "CesiumTerrainProvider",
      hasWaterMask: true,
      waitedMs: 5,
    },
  });
  const result = await run(harness, { requiresIon: true });
  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.notRun, "NOT_RUN: ion");
  assert.equal(result.png, null);
  assert.equal(harness.log.capture.length, 0, "a NOT RUN leaves no picture");
  assert.equal(harness.log.settle.length, 0, "and settles nothing");
});

test("D2: a terrain provider that never leaves the ellipsoid answers NOT_RUN: ion", async () => {
  const harness = makeHarness({
    ion: {
      tokenPresent: true,
      terrainResolved: false,
      terrainProvider: "EllipsoidTerrainProvider",
      hasWaterMask: false,
      waitedMs: 60000,
    },
  });
  const result = await run(harness, { requiresIon: true });
  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.notRun, "NOT_RUN: ion");
  assert.equal(result.png, null);
  assert.equal(harness.log.capture.length, 0);
});

test("D2: a demo that needs ion with a token and resolved terrain is CAPTURED, its ionAccess in the record", async () => {
  const harness = makeHarness();
  const result = await run(harness, { requiresIon: true });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.notRun, null);
  assert.equal(harness.log.ion.length, 1, "ion is asked about once");
  assert.equal(result.record.ionAccess.required, true);
  assert.equal(result.record.ionAccess.tokenPresent, true);
  assert.equal(result.record.ionAccess.terrainResolved, true);
});

test("D2: when ion is not required it is never asked about, even with no token and ion declared unavailable", async () => {
  const harness = makeHarness({
    ion: { tokenPresent: false, terrainResolved: false },
  });
  const result = await run(harness, {
    requiresIon: false,
    ionAvailable: false,
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(harness.log.ion.length, 0, "the ion wait must not run");
  assert.equal(harness.log.open.length, 1, "the page is opened");
  assert.equal(result.record.ionAccess.required, false);
});

test("D3: a context running a different backend than requested refuses with demo-renderer-gate", async () => {
  const harness = makeHarness({ renderer: "webgl" });
  await assert.rejects(
    run(harness, { renderer: "webgpu" }),
    refusal("demo-renderer-gate"),
  );
  assert.equal(harness.log.capture.length, 0);
  assert.equal(harness.log.settle.length, 0);
});

test("D3: a webgpu context for a webgl request refuses too", async () => {
  const harness = makeHarness({ renderer: "webgpu" });
  await assert.rejects(
    run(harness, { renderer: "webgl" }),
    refusal("demo-renderer-gate"),
  );
  assert.equal(harness.log.capture.length, 0);
});

test("D3: a frame that never publishes a viewer refuses with demo-no-viewer", async () => {
  const harness = makeHarness({ noViewer: true });
  await assert.rejects(run(harness), refusal("demo-no-viewer"));
  assert.equal(harness.log.capture.length, 0);
});

test("D3: a frame that does not answer within the read budget refuses with demo-frame-unreadable", async () => {
  const harness = makeHarness({ frameUnreadable: true });
  await assert.rejects(
    run(harness, { budgets: { readMs: 25 } }),
    refusal("demo-frame-unreadable"),
  );
  assert.equal(harness.log.capture.length, 0);
});

test("D3: a settle short of the frame count refuses with demo-not-settled", async () => {
  const harness = makeHarness({
    settle: { outcome: "done", settledFrames: 239, frameNumber: 900 },
  });
  await assert.rejects(run(harness), refusal("demo-not-settled"));
  assert.equal(harness.log.capture.length, 0);
});

test("D3: a settle that ended on its deadline refuses with demo-not-settled even if some frames were drawn", async () => {
  const harness = makeHarness({
    settle: { outcome: "deadline", settledFrames: 3, frameNumber: 40 },
  });
  await assert.rejects(run(harness), refusal("demo-not-settled"));
  assert.equal(harness.log.capture.length, 0);
});

test("D3: a clock that could not be pinned refuses with demo-clock-not-pinned before any settle", async () => {
  const harness = makeHarness({
    clockAnswer: { applied: false, reason: "no clock" },
  });
  await assert.rejects(
    run(harness, { clock: "2026-06-21T16:00:00Z" }),
    refusal("demo-clock-not-pinned"),
  );
  assert.equal(harness.log.settle.length, 0);
  assert.equal(harness.log.capture.length, 0);
});

test("D3: a clock that is pinned is applied before the settle and the demo is captured", async () => {
  const harness = makeHarness();
  const result = await run(harness, { clock: "2026-06-21T16:00:00Z" });
  assert.equal(result.status, "CAPTURED");
  assert.equal(harness.log.clock.length, 1);
  assert.equal(harness.log.clock[0].iso, "2026-06-21T16:00:00Z");
  assert.ok(
    harness.log.steps.indexOf("clock") < harness.log.steps.indexOf("settle"),
    `the clock must be pinned before the settle: ${harness.log.steps.join(" > ")}`,
  );
});

test("D3: without a clock the piece never touches the demo's clock", async () => {
  const harness = makeHarness();
  await run(harness);
  assert.equal(harness.log.clock.length, 0);
});

const BAD_REQUESTS = [
  ["a non-http origin", { origin: "ftp://localhost:8080" }],
  ["a file origin", { origin: "file:///tmp/x" }],
  ["an origin with no port", { origin: "http://localhost" }],
  ["an origin that is not a URL", { origin: "not a url" }],
  ["a demo id with a path escape", { demoId: "../x" }],
  ["an empty demo id", { demoId: "" }],
  ["a demo id with a slash", { demoId: "a/b" }],
  ["a missing demo id", { demoId: undefined }],
  ["a renderer other than webgl/webgpu", { renderer: "webgl2" }],
  ["a capitalised renderer", { renderer: "WebGPU" }],
  ["zero frames", { frames: 0 }],
  ["negative frames", { frames: -3 }],
  ["a fractional frame count", { frames: 1.5 }],
  ["a string frame count", { frames: "240" }],
  ["a clock with no Z", { clock: "2026-06-21T16:00:00" }],
  ["a clock with an offset", { clock: "2026-06-21T16:00:00+02:00" }],
  ["a clock with a space", { clock: "2026-06-21 16:00:00Z" }],
];

for (const [label, overrides] of BAD_REQUESTS) {
  test(`D4: demoCaptureRequest throws TypeError for ${label}`, () => {
    assert.throws(
      () => demoCaptureRequest(request(overrides)),
      (error) => error instanceof TypeError,
    );
  });
}

test("D4: captureSandcastle2Demo rejects a bad request before opening anything", async () => {
  const harness = makeHarness();
  await assert.rejects(
    run(harness, { demoId: "../x" }),
    (error) => error instanceof TypeError,
  );
  assert.equal(harness.log.open.length, 0);
});

test("D4: a well-formed request is accepted", () => {
  assert.doesNotThrow(() =>
    demoCaptureRequest(request({ clock: "2026-06-21T16:00:00Z", frames: 1 })),
  );
});

const deepFreeze = (value) => {
  for (const inner of Object.values(value)) {
    if (inner && typeof inner === "object") {
      deepFreeze(inner);
    }
  }
  return Object.freeze(value);
};

test("D5: decideIonAccess reports no NOT_RUN when ion is not required, whatever was observed", () => {
  for (const observed of [
    null,
    { tokenPresent: false, terrainResolved: false },
    { tokenPresent: true, terrainResolved: true },
  ]) {
    assert.equal(
      decideIonAccess({ requiresIon: false, ionAvailable: false }, observed)
        .notRun,
      null,
    );
  }
});

test("D5: decideIonAccess passes only on a token AND a resolved terrain", () => {
  const need = { requiresIon: true, ionAvailable: null };
  assert.equal(
    decideIonAccess(need, { tokenPresent: true, terrainResolved: true }).notRun,
    null,
  );
  assert.equal(
    decideIonAccess(need, { tokenPresent: false, terrainResolved: true })
      .notRun,
    "NOT_RUN: ion",
  );
  assert.equal(
    decideIonAccess(need, { tokenPresent: true, terrainResolved: false })
      .notRun,
    "NOT_RUN: ion",
  );
  assert.equal(decideIonAccess(need, {}).notRun, "NOT_RUN: ion");
  assert.equal(decideIonAccess(need, null).notRun, "NOT_RUN: ion");
});

test("D5: decideIonAccess answers NOT_RUN: ion for a declared-unavailable ion even if the frame reported a token", () => {
  assert.equal(
    decideIonAccess(
      { requiresIon: true, ionAvailable: false },
      { tokenPresent: true, terrainResolved: true },
    ).notRun,
    "NOT_RUN: ion",
  );
});

test("D5: decideIonAccess is pure: frozen inputs are accepted, unchanged, and the answer repeats", () => {
  const requestIn = deepFreeze({ requiresIon: true, ionAvailable: null });
  const observed = deepFreeze({ tokenPresent: true, terrainResolved: true });
  const first = decideIonAccess(requestIn, observed);
  const second = decideIonAccess(requestIn, observed);
  assert.deepEqual(first, second);
  assert.deepEqual(requestIn, { requiresIon: true, ionAvailable: null });
  assert.deepEqual(observed, { tokenPresent: true, terrainResolved: true });
});

test("D6: the gate the piece returns is what readGate read from the run frame", async () => {
  const harness = makeHarness();
  const answer = {
    errors: ["[webgpu] uncaptured GPU error: G-STUB"],
    deviceLost: null,
    armedDevices: 1,
  };
  const result = await run(harness, {}, { readGate: async () => answer });
  assert.equal(result.gate, answer);
});

test("D7 (A2-3): a settle short of its frames reads the run frame's gate first and carries it in the refusal's details", async () => {
  const harness = makeHarness({
    settle: { outcome: "deadline", settledFrames: 3, frameNumber: 40 },
  });
  const lost = {
    errors: [],
    deviceLost: "[webgpu] device lost: reason=unknown D7-STUB",
    armedDevices: 1,
  };
  const reads = [];
  await assert.rejects(
    run(
      harness,
      {},
      {
        readGate: async (target) => {
          reads.push(target);
          return lost;
        },
      },
    ),
    (error) => {
      refusal("demo-not-settled")(error);
      assert.equal(error.details.gate, lost);
      assert.equal(error.details.gateReadError, undefined);
      assert.equal(error.details.settle.settledFrames, 3);
      return true;
    },
  );
  assert.deepEqual(reads, [harness.frame], "read once, on the run frame");
  assert.equal(harness.log.capture.length, 0);
});

test("D7 (A2-3): a clock the piece could not pin reads the gate first and carries it; the settle never runs", async () => {
  const harness = makeHarness({
    clockAnswer: { applied: false, reason: "no clock" },
  });
  await assert.rejects(
    run(harness, { clock: "2026-06-21T16:00:00Z" }),
    (error) => {
      refusal("demo-clock-not-pinned")(error);
      assert.deepEqual(error.details.gate, {
        errors: [],
        deviceLost: null,
        armedDevices: 1,
      });
      return true;
    },
  );
  assert.deepEqual(harness.log.gates, [harness.frame]);
  assert.equal(harness.log.settle.length, 0);
});

test("D7 (A2-3): a gate read that fails before a refusal is recorded, and the refusal is still the answer", async () => {
  const harness = makeHarness({
    settle: { outcome: "frame-cap", settledFrames: 0, frameNumber: 12000 },
  });
  await assert.rejects(
    run(
      harness,
      {},
      {
        readGate: async () => {
          throw new Error("D7 frame detached");
        },
      },
    ),
    (error) => {
      refusal("demo-not-settled")(error);
      assert.equal(error.details.gate, null);
      assert.equal(error.details.gateReadError, "D7 frame detached");
      return true;
    },
  );
});

test("D7 (A2-3): a refusal before the gate is armed (the wrong renderer) reads no gate", async () => {
  const harness = makeHarness({ renderer: "webgl" });
  await assert.rejects(run(harness), (error) => {
    refusal("demo-renderer-gate")(error);
    assert.equal(Object.hasOwn(error.details, "gate"), false);
    return true;
  });
  assert.equal(harness.log.gates.length, 0);
});

test("D6: the piece arms the demo's devices in the run frame and returns what the arming answered", async () => {
  const harness = makeHarness();
  const result = await run(harness);
  assert.deepEqual(result.armed, { found: 1, armed: 1, gateInstalled: true });
  assert.ok(
    harness.log.steps.indexOf("arm") < harness.log.steps.indexOf("capture"),
    `the arming must precede the capture: ${harness.log.steps.join(" > ")}`,
  );
});

// ---------------------------------------------------------------------------
// X: the in-frame functions EXECUTED in Node against a fake run frame
// (Ravenhill pass 1, B1(c)). The run frame's globals live on globalThis for
// the length of one test: a GPUAdapter, the demo's published instance, the
// error gate and the frame driver the piece installs. Nothing here is
// answered by shape: the piece's own page functions run.
// ---------------------------------------------------------------------------

const WORLD_GLOBALS = [
  "window",
  "GPUAdapter",
  "__sandcastleInstances",
  "__webgpuGate",
  "__armWebGPUDevice",
  SCENE_FRAME_DRIVER_GLOBAL,
];

/**
 * A fake run frame. `tilesLoadedFrom` is the first frame drawn with
 * `globe.tilesLoaded` true (null: never); `errorOnFrame` raises an uncaptured
 * GPU error on that frame through whatever handler the device carries.
 */
function makeWorld({ tilesLoadedFrom = 1, errorOnFrame = null } = {}) {
  for (const name of WORLD_GLOBALS) {
    assert.equal(globalThis[name], undefined, `${name} leaked into the world`);
  }
  globalThis.window = globalThis;
  class GPUAdapter {
    async requestDevice() {
      return { label: "adapter-device", lost: new Promise(() => {}) };
    }
  }
  globalThis.GPUAdapter = GPUAdapter;
  const listeners = new Set();
  const world = { drawn: 0, scene: null };
  let pending = false;
  const scene = {
    context: { _device: null },
    globe: { tilesLoaded: false },
    frameState: { frameNumber: 0 },
    postRender: {
      addEventListener(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    requestRender() {
      if (pending) {
        return;
      }
      pending = true;
      setImmediate(() => {
        pending = false;
        world.drawn += 1;
        scene.frameState.frameNumber = world.drawn;
        scene.globe.tilesLoaded =
          tilesLoadedFrom !== null && world.drawn >= tilesLoadedFrom;
        if (world.drawn === errorOnFrame) {
          scene.context._device?.onuncapturederror?.({
            error: { message: "X-STUB" },
          });
        }
        for (const fn of [...listeners]) {
          fn();
        }
      });
    },
  };
  world.scene = scene;
  world.frame = {
    async waitForFunction(fn) {
      assert.ok(fn(), "the demo's viewer is published");
    },
    async evaluate(fn, arg) {
      if (fn === readRendererStateInPage) {
        return {
          contexts: [{ id: "ctx-world", rendererType: "webgpu" }],
          frameNumbers: [world.drawn],
          note: "",
        };
      }
      if (typeof fn === "string") {
        // The runtime's installer: the driver's own source under its global.
        assert.ok(fn.includes(SCENE_FRAME_DRIVER_GLOBAL), fn.slice(0, 80));
        globalThis[SCENE_FRAME_DRIVER_GLOBAL] = driveSceneFrames;
        return undefined;
      }
      return fn(arg);
    },
  };
  world.publish = (device) => {
    scene.context._device = device;
    globalThis.__sandcastleInstances = [{ scene, clock: null }];
  };
  world.dispose = () => {
    for (const name of WORLD_GLOBALS) {
      delete globalThis[name];
    }
  };
  return world;
}

/** Run every init script the piece adds to a context, in order. */
async function runInitScripts() {
  const scripts = [];
  await prepareDemoCaptureContext({
    async addInitScript(fn) {
      scripts.push(fn);
    },
  });
  for (const script of scripts) {
    script();
  }
  return scripts.length;
}

async function runInWorld(world, requestOverrides = {}) {
  const captured = [];
  return {
    captured,
    result: await captureSandcastle2Demo({
      page: { tag: "top-page" },
      request: request({ frames: 5, ...requestOverrides }),
      outputDirectory: OUTPUT_DIRECTORY,
      captures: [],
      dependencies: {
        async open() {
          return {
            url: "http://stub/open",
            finalUrl: "http://stub/final",
            bucketFrame: world.frame,
            bucketFinalUrl: "http://stub/bucket",
            assertNoOriginBreach() {},
          };
        },
        async capture(args) {
          captured.push({ drawn: world.drawn, args });
          return {
            name: args.name,
            path: path.join("relative-out", `${args.name}.png`),
            sha256: "00ff",
            byteLength: 3,
            liveness: { state: "live", frameNumber: world.drawn },
          };
        },
      },
    }),
  };
}

test("X1: the settle counts only frames drawn with the globe's tiles loaded", async () => {
  const world = makeWorld({ tilesLoadedFrom: 11 });
  try {
    await runInitScripts();
    world.publish({ label: "bare-device", lost: new Promise(() => {}) });
    const { result, captured } = await runInWorld(world, { frames: 5 });
    assert.equal(result.status, "CAPTURED");
    assert.equal(result.settle.outcome, "done");
    assert.equal(result.settle.settledFrames, 5);
    assert.equal(
      result.settle.frames,
      15,
      "ten frames drawn while tiles streamed, then five settled",
    );
    assert.equal(captured[0].drawn, 15, "the capture follows the settle");
  } finally {
    world.dispose();
  }
});

test("X1: a globe whose tiles never load is never settled, whatever the frame count drawn", async () => {
  const world = makeWorld({ tilesLoadedFrom: null });
  try {
    await runInitScripts();
    world.publish({ label: "bare-device", lost: new Promise(() => {}) });
    await assert.rejects(
      runInWorld(world, { frames: 5, settleMaxFrames: 20 }),
      (error) => {
        assert.ok(error instanceof ProbeRefusal, String(error));
        assert.equal(error.reason, "demo-not-settled");
        assert.equal(error.details.settle.outcome, "frame-cap");
        assert.equal(error.details.settle.settledFrames, 0);
        return true;
      },
    );
    assert.equal(world.drawn, 20);
  } finally {
    world.dispose();
  }
});

test("X2: the context's init scripts arm a device the demo requests from its adapter at the moment it is created", async () => {
  const world = makeWorld();
  try {
    assert.equal(await runInitScripts(), 2);
    const device = await new globalThis.GPUAdapter().requestDevice();
    assert.equal(device.__gateArmed, true, "armed on request");
    assert.equal(globalThis.__webgpuGate.armedDevices, 1);
    world.publish(device);
    const { result } = await runInWorld(world);
    assert.deepEqual(
      result.armed,
      { found: 1, armed: 0, gateInstalled: true },
      "the frame-side arming finds the device already armed",
    );
    assert.equal(result.gate.armedDevices, 1);
  } finally {
    world.dispose();
  }
});

test("X3: a device the demo did not request through the hook is armed by the piece, and the gate it returns carries the device's fault", async () => {
  const world = makeWorld({ errorOnFrame: 3 });
  try {
    await runInitScripts();
    const device = { label: "bare-device", lost: new Promise(() => {}) };
    world.publish(device);
    const { result } = await runInWorld(world);
    assert.deepEqual(result.armed, { found: 1, armed: 1, gateInstalled: true });
    assert.equal(device.__gateArmed, true);
    assert.deepEqual(result.gate, {
      errors: ["[webgpu] uncaptured GPU error: X-STUB"],
      deviceLost: null,
      armedDevices: 1,
    });
  } finally {
    world.dispose();
  }
});
