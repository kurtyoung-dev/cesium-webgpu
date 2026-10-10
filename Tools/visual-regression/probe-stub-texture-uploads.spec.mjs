// probe-stub-texture-uploads.spec.mjs - the label-atlas probe's steps keep a
// request-render-mode scene rendering, and a page that stops answering refuses
// the cell by name inside the cell's budget. Pure Node: no browser.
//
//   node --test Tools/visual-regression/probe-stub-texture-uploads.spec.mjs
//
// @purpose Pins that the runtime's scene frame driver renders a scene in request-render mode to the frame its step asks for, that a scene which stops rendering ends at the driver's wall-clock deadline rather than never, that the label atlas steps run to completion over the driver and refuse by name when the driver ends them early, and that the probe's cell budget turns a browser call that never returns into a named refusal within the budget.
// @status ACTIVE
//
// WHAT THIS IS ABOUT. `Apps/CesiumViewer` sets `scene.requestRenderMode` at
// startup, so a scene there renders only when asked. A step sequence that
// requested one render and then counted `postRender` events waited forever
// once the scene went quiet, and the `page.evaluate` awaiting it had no
// timeout, so the cell's budget never fired and the run ended at its orderly
// deadline with no cell record.
//
// HOW IT IS TESTED. The fake scene below renders a frame (on a timer, as a
// browser's render loop would) only while a render is requested, plus a few
// frames of its own pending work after the first request, and then goes quiet
// unless asked again: the request-render behaviour measured on the served
// CesiumViewer page. A second fake renders nothing at all. The driver is
// installed through `installSceneFrameDriver` against a page whose `evaluate`
// runs the installed source text, so the serialised driver is what runs. The
// label steps import a fake engine module from a `data:` URL whose
// `LabelCollection` grows its atlas on the frame after a second label arrives.
//
// RUNNER HOME. `test-visual-probe-contracts` (package.json; the seat owns the
// line).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runInThisContext } from "node:vm";

import {
  decideAtlasGrowth,
  pageRunLabelAtlasGrowth,
} from "./lib/label-atlas-growth-steps.mjs";
import {
  ProbeRefusal,
  SCENE_FRAME_DRIVER_GLOBAL,
  driveSceneFrames,
  installSceneFrameDriver,
} from "./lib/probe-runtime.mjs";
import { createCellBudget } from "./probe-stub-texture-uploads.mjs";
import {
  GPU_CALL_TRACE_GLOBAL,
  STUB_TEXTURE_TRACE_GLOBAL,
  stubTextureTraceInit,
} from "./lib/stub-texture-trace.mjs";

/** A scene in request-render mode: renders only while a render is requested. */
function makeRequestRenderScene({
  pendingFrames = 3,
  frameIntervalMs = 1,
} = {}) {
  const listeners = new Set();
  let requested = false;
  let pending = 0;
  let scheduled = false;
  let started = false;
  const scene = {
    frames: 0,
    requests: 0,
    postRender: {
      addEventListener(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    requestRender() {
      scene.requests += 1;
      requested = true;
      if (!started) {
        started = true;
        pending = pendingFrames;
      }
      schedule();
    },
  };
  function schedule() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    setTimeout(tick, frameIntervalMs);
  }
  function tick() {
    scheduled = false;
    if (!requested && pending === 0) {
      return;
    }
    if (requested) {
      requested = false;
    } else {
      pending -= 1;
    }
    scene.frames += 1;
    for (const listener of [...listeners]) {
      listener();
    }
    if (requested || pending > 0) {
      schedule();
    }
  }
  return scene;
}

/** A scene whose render loop has stopped: requests are accepted, nothing renders. */
function makeStoppedScene() {
  return {
    requests: 0,
    postRender: {
      addEventListener() {
        return () => {};
      },
    },
    requestRender() {
      this.requests += 1;
    },
  };
}

/** A page whose `evaluate` runs installed source text in this realm. */
const sourcePage = {
  async evaluate(source) {
    assert.equal(typeof source, "string");
    runInThisContext(source);
  },
};

afterEach(() => {
  delete globalThis[SCENE_FRAME_DRIVER_GLOBAL];
  delete globalThis.viewer;
});

describe("the scene frame driver", () => {
  it(
    "keeps a request-render-mode scene rendering until the step says it is done",
    { timeout: 15_000 },
    async () => {
      const scene = makeRequestRenderScene({ pendingFrames: 3 });
      const result = await driveSceneFrames(scene, {
        onFrame: (frame) => frame >= 90,
        maxFrames: 600,
        deadlineMs: 10_000,
      });
      assert.equal(result.outcome, "done");
      assert.equal(result.frames, 90);
      assert.equal(scene.frames, 90, "the scene rendered every driven frame");
    },
  );

  it(
    "ends at its wall-clock deadline when the scene renders nothing",
    { timeout: 15_000 },
    async () => {
      const started = Date.now();
      const result = await driveSceneFrames(makeStoppedScene(), {
        onFrame: () => false,
        maxFrames: 600,
        deadlineMs: 150,
      });
      const elapsed = Date.now() - started;
      assert.equal(result.outcome, "deadline");
      assert.equal(result.frames, 0);
      assert.ok(elapsed >= 140 && elapsed < 2_000, `ended after ${elapsed} ms`);
    },
  );

  it("ends at its frame cap, and names a step that throws", async () => {
    const capped = await driveSceneFrames(makeRequestRenderScene(), {
      onFrame: () => false,
      maxFrames: 12,
      deadlineMs: 10_000,
    });
    assert.deepEqual([capped.outcome, capped.frames], ["frame-cap", 12]);

    const failed = await driveSceneFrames(makeRequestRenderScene(), {
      onFrame: (frame) => {
        if (frame === 4) {
          throw new Error("step broke");
        }
        return false;
      },
      maxFrames: 600,
      deadlineMs: 10_000,
    });
    assert.equal(failed.outcome, "step-error");
    assert.equal(failed.frames, 4);
    assert.equal(failed.error, "step broke");
  });

  it("installs in a page as source text that runs on its own", async () => {
    await installSceneFrameDriver(sourcePage);
    const installed = globalThis[SCENE_FRAME_DRIVER_GLOBAL];
    assert.equal(typeof installed, "function");
    assert.notEqual(installed, driveSceneFrames, "a copy made from its source");
    const result = await installed(makeRequestRenderScene(), {
      onFrame: (frame) => frame >= 20,
      maxFrames: 600,
      deadlineMs: 10_000,
    });
    assert.deepEqual([result.outcome, result.frames], ["done", 20]);
  });
});

// -- the label atlas steps over the driver --------------------------------------

/**
 * A fake engine module: just what the steps construct. The label collection's
 * glyph atlas is 64x64 once it holds one label and grows to 128x128 on the
 * frame after a second label arrives, the way a TextureAtlas grows in the
 * after-render callbacks.
 */
const FAKE_ENGINE_SOURCE = `
export const Color = { BLACK: "black", WHITE: "white" };
export const Cartesian3 = { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) };
export const HorizontalOrigin = { CENTER: 0 };
export const VerticalOrigin = { CENTER: 0 };
export class LabelCollection {
  constructor({ scene }) {
    this.labels = [];
    const atlas = { guid: "atlas-1", _texture: null };
    this._glyphBillboardCollection = { _textureAtlas: atlas };
    scene.__beforeListeners.push(() => {
      const size = this.labels.length >= 2 ? 128 : this.labels.length === 1 ? 64 : 0;
      atlas._texture = size > 0 ? { width: size, height: size } : null;
    });
  }
  add(label) {
    this.labels.push(label);
  }
}
`;
const FAKE_ENGINE_URL = `data:text/javascript;base64,${Buffer.from(FAKE_ENGINE_SOURCE).toString("base64")}`;

/**
 * Put a fake viewer on the global object over a scene; its after-render work
 * (`__beforeListeners`) runs before every `postRender`, as the scene's
 * after-render callbacks do.
 */
function installViewer(scene) {
  scene.__beforeListeners = [];
  const addEventListener = scene.postRender.addEventListener;
  scene.postRender.addEventListener = (listener, context) => {
    return addEventListener((...args) => {
      for (const before of scene.__beforeListeners) {
        before();
      }
      listener(...args);
    }, context);
  };
  scene.globe = { show: true };
  scene.primitives = { add: (primitive) => primitive };
  globalThis.viewer = {
    scene,
    camera: { setView() {} },
  };
}

const STEP_ARGS = Object.freeze({
  moduleUrl: FAKE_ENGINE_URL,
  hideScene: true,
  font: "bold 48px monospace",
  batches: [
    { frame: 5, lat: 12, text: "ABCDEFGH" },
    { frame: 30, lat: -12, text: "IJKLMNOPQRSTUVWXYZ0123456789" },
  ],
  camera: { lon: 0, lat: 0, height: 10_000_000 },
  settleFrames: 60,
  maxFrames: 600,
  driverGlobal: SCENE_FRAME_DRIVER_GLOBAL,
});

describe("the label atlas steps", () => {
  it(
    "run to the settle on a request-render-mode scene and see the atlas grow",
    { timeout: 15_000 },
    async () => {
      installViewer(makeRequestRenderScene({ pendingFrames: 3 }));
      await installSceneFrameDriver(sourcePage);

      const result = await pageRunLabelAtlasGrowth({
        ...STEP_ARGS,
        deadlineMs: 10_000,
      });

      assert.equal(result.outcome, "done");
      assert.equal(result.completed, true);
      assert.deepEqual(result.batchFrames, [5, 30]);
      assert.equal(result.frames, 90);
      assert.deepEqual(decideAtlasGrowth(result), {
        before: { width: 64, height: 64, frame: 30 },
        after: { width: 128, height: 128, frame: 90 },
        resizedOnFrame: 31,
      });
    },
  );

  it(
    "refuse by name, inside the deadline, when the scene stops rendering",
    { timeout: 15_000 },
    async () => {
      installViewer(makeStoppedScene());
      await installSceneFrameDriver(sourcePage);

      const started = Date.now();
      const result = await pageRunLabelAtlasGrowth({
        ...STEP_ARGS,
        deadlineMs: 200,
      });
      const elapsed = Date.now() - started;

      assert.equal(result.outcome, "deadline");
      assert.equal(result.completed, false);
      assert.ok(elapsed < 2_000, `the steps returned after ${elapsed} ms`);
      assert.throws(
        () => decideAtlasGrowth(result),
        (error) =>
          error instanceof ProbeRefusal &&
          error.reason === "atlas-steps-did-not-finish" &&
          error.details.outcome === "deadline",
      );
    },
  );

  it("refuse when the frame driver is not installed", async () => {
    installViewer(makeRequestRenderScene());
    await assert.rejects(
      pageRunLabelAtlasGrowth({ ...STEP_ARGS, deadlineMs: 1_000 }),
      /frame driver is not installed/,
    );
  });
});

// -- the probe's cell budget ------------------------------------------------------

describe("the probe's cell budget", () => {
  it(
    "turns a browser call that never returns into a named refusal within the budget",
    { timeout: 15_000 },
    async () => {
      const budget = createCellBudget({
        scene: "atlas",
        renderer: "webgl",
        budgetMs: 150,
      });
      const started = Date.now();
      await assert.rejects(
        budget.bound("the label atlas steps", () => new Promise(() => {})),
        (error) =>
          error instanceof ProbeRefusal &&
          error.reason === "cell-over-budget" &&
          error.details.step === "the label atlas steps",
      );
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed >= 140 && elapsed < 2_000,
        `refused after ${elapsed} ms`,
      );
    },
  );

  it("returns what a call returns, and refuses at once when the budget is spent", async () => {
    let clock = 0;
    const budget = createCellBudget({
      scene: "video",
      renderer: "webgpu",
      budgetMs: 1_000,
      now: () => clock,
    });
    assert.equal(await budget.bound("a quick call", async () => 42), 42);
    assert.equal(budget.remainingMs(), 1_000);
    clock = 1_000;
    assert.equal(budget.remainingMs(), 0);
    await assert.rejects(
      budget.bound("a late call", async () => 1),
      (error) => error.reason === "cell-over-budget",
    );
  });

  it("absorbs the rejection of a call it has already given up on", async () => {
    const budget = createCellBudget({
      scene: "atlas",
      renderer: "webgpu",
      budgetMs: 50,
    });
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await assert.rejects(
        budget.bound(
          "a call the closing context rejects",
          () =>
            new Promise((resolve, reject) => {
              setTimeout(() => reject(new Error("Target closed")), 120);
            }),
        ),
        (error) => error.reason === "cell-over-budget",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });
});

describe("the texture trace's WebGPU call counters", () => {
  it("name each texture by a serial id across create, copy, submit and destroy, attribute a submit to its encoder's label, and arm the engine receipt", () => {
    const names = [
      "GPUDevice",
      "GPUCommandEncoder",
      "GPUQueue",
      "GPUTexture",
      GPU_CALL_TRACE_GLOBAL,
      STUB_TEXTURE_TRACE_GLOBAL,
    ];
    const saved = Object.fromEntries(
      names.map((name) => [name, globalThis[name]]),
    );
    class GPUTexture {
      constructor(descriptor) {
        this.label = descriptor.label;
        this.width = descriptor.size.width;
        this.height = descriptor.size.height;
      }
      destroy() {}
    }
    class GPUCommandEncoder {
      constructor(label) {
        this.label = label;
      }
      copyTextureToTexture() {}
      finish() {
        return {};
      }
    }
    class GPUQueue {
      submit() {}
      copyExternalImageToTexture() {}
      writeTexture() {}
    }
    class GPUDevice {
      createTexture(descriptor) {
        return new GPUTexture(descriptor);
      }
    }
    class HTMLVideoElement {
      width = 0;
      height = 0;
      videoWidth = 640;
      videoHeight = 360;
    }
    Object.assign(globalThis, {
      GPUDevice,
      GPUCommandEncoder,
      GPUQueue,
      GPUTexture,
    });
    delete globalThis[GPU_CALL_TRACE_GLOBAL];
    delete globalThis[STUB_TEXTURE_TRACE_GLOBAL];
    try {
      stubTextureTraceInit();
      const device = new GPUDevice();
      const queue = new GPUQueue();
      const source = device.createTexture({
        label: "GLStub_Texture",
        size: { width: 4, height: 2 },
      });
      const destination = device.createTexture({
        label: "GLStub_Texture",
        size: { width: 8, height: 4 },
      });
      const offFrame = new GPUCommandEncoder("GLStub_OffFrameTextureCopy");
      offFrame.copyTextureToTexture(
        { texture: source, origin: { x: 0, y: 0 } },
        { texture: destination, origin: { x: 4, y: 0 } },
        { width: 4, height: 2 },
      );
      queue.submit([
        offFrame.finish(),
        new GPUCommandEncoder("frame").finish(),
      ]);
      queue.copyExternalImageToTexture(
        { source: new HTMLVideoElement() },
        { texture: destination },
        { width: 640, height: 360 },
      );
      source.destroy();

      const trace = globalThis[GPU_CALL_TRACE_GLOBAL];
      assert.equal(trace.counts["createTexture.GLStub_Texture"], 2);
      assert.equal(
        trace.counts["copyTextureToTexture.GLStub_OffFrameTextureCopy"],
        1,
      );
      const copy =
        trace.samples["copyTextureToTexture.GLStub_OffFrameTextureCopy"][0];
      assert.deepEqual([copy.source.id, copy.destination.id], [1, 2]);
      assert.equal(trace.counts["submit.GLStub_OffFrameTextureCopy"], 1);
      assert.equal(trace.counts["submit.frame"], 1);
      assert.deepEqual(trace.samples["destroy.GLStub_Texture"][0], {
        id: 1,
        label: "GLStub_Texture",
        width: 4,
        height: 2,
      });
      assert.deepEqual(
        trace.samples["copyExternalImageToTexture.HTMLVideoElement"][0].element,
        { width: 0, height: 0, videoWidth: 640, videoHeight: 360 },
      );
      assert.deepEqual(globalThis[STUB_TEXTURE_TRACE_GLOBAL], {
        counts: {},
        samples: {},
      });
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) {
          delete globalThis[name];
        } else {
          globalThis[name] = saved[name];
        }
      }
    }
  });
});
