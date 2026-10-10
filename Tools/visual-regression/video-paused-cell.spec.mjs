// video-paused-cell.spec.mjs - the Sandcastle2 Video demo's paused cell waits
// a bounded time for the scene's first render before it judges readiness, and
// the moving video cell's spread band is judged on one video frame shared by
// both renderers. Pure Node: no browser.
//
//   node --test Tools/visual-regression/video-paused-cell.spec.mjs
//
// @purpose Pins that the paused video cell's readiness wait tolerates a scene that has not rendered yet for at most its registered bound (the smaller of the rig's firstRenderMaxMs and the cell's deadline), drives the scene once its first render arrives, and refuses with no-scene-rendered only when no render arrives within the bound; and that the moving video cell's spread band compares the two renderers' frame-matched captures, met within the rig's factor, void when either has none.
// @status ACTIVE
//
// WHAT THIS IS ABOUT. On Edge the paused cell's WebGPU capture was refused
// twice because the readiness wait gave up at once when the WebGPU viewer had
// not yet rendered a frame; it rendered 745 ms later. And the moving cell's
// spread band compared a WebGPU capture that landed on a title card with a
// WebGL capture in a shot, so it failed on a textured surface. The cases below
// pin the observable outcome of each: what the wait returns for a first render
// that arrives late, never, or before the wait; and what the band says for
// matched spreads.
//
// HOW IT IS TESTED. `frameAwaitPausedSurfaceDrawn` runs in the Sandcastle2 run
// frame from its serialised source, so the spec evaluates that source text and
// runs the result, with the kit's frame driver installed through
// `installSceneFrameDriver` from its own source text. The fake scene renders a
// frame on a timer whenever a render is requested; the dials global records it
// as rendered only when the case says its first render has happened, as the
// dials' `Scene.render` wrap does in the page.
//
// RUNNER HOME. `test-visual-probe-contracts` (package.json; the seat owns the
// line).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runInThisContext } from "node:vm";

import {
  SCENE_FRAME_DRIVER_GLOBAL,
  installSceneFrameDriver,
} from "./lib/probe-runtime.mjs";
import {
  VIDEO_PAUSED_DIALS_GLOBAL,
  frameAwaitPausedSurfaceDrawn,
} from "./lib/video-paused-cell.mjs";
import {
  judgeMatchedSpread,
  pairStubTextureCells,
} from "./probe-stub-texture-uploads.mjs";
import VIDEO_RIG from "./rigs/sandcastle2-video.mjs";

const TRACE_GLOBAL = "__sceneTextureTrace";

/** The frame function as the page runs it: from its source text alone. */
const awaitSurfaceDrawn = runInThisContext(
  `(${frameAwaitPausedSurfaceDrawn.toString()})`,
);

/** A page whose `evaluate` runs installed source text in this realm. */
const sourcePage = {
  async evaluate(source) {
    assert.equal(typeof source, "string");
    runInThisContext(source);
  },
};

/** A scene that renders one frame per request, on a timer. */
function makeScene({ tracking = true } = {}) {
  const listeners = new Set();
  let scheduled = false;
  const scene = {
    frames: 0,
    camera: {
      transform: tracking
        ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 300, 1]
        : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
    postRender: {
      addEventListener(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    requestRender() {
      if (scheduled) {
        return;
      }
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        scene.frames += 1;
        for (const listener of [...listeners]) {
          listener();
        }
      }, 1);
    },
  };
  return scene;
}

/** The page state of a demo whose video material is adopted and drawn. */
function installDemoState() {
  class FakeVideoElement {}
  globalThis.HTMLVideoElement = FakeVideoElement;
  globalThis.document = {
    querySelector: () => ({ width: 1280, height: 687 }),
  };
  const material = {
    uniforms: { image: new FakeVideoElement() },
    _textures: { image: { width: 640, height: 360 } },
  };
  globalThis[TRACE_GLOBAL] = {
    videoMaterials: [material],
    videoPrimitives: [{ appearance: { material }, ready: true }],
  };
  const dials = { scenes: new Set(), renders: 0, installed: [] };
  globalThis[VIDEO_PAUSED_DIALS_GLOBAL] = dials;
  return dials;
}

/** The dials' first-render record, as the `Scene.render` wrap makes it. */
function firstRender(dials, scene) {
  dials.scenes.add(scene);
  dials.renders += 1;
}

const ARGS = Object.freeze({
  driverGlobal: SCENE_FRAME_DRIVER_GLOBAL,
  settleFrames: 5,
  maxFrames: 500,
  deadlineMs: 10_000,
  selector: ".cesium-widget canvas",
});

describe("the paused cell's readiness wait tolerates a late first render, within a bound", () => {
  beforeEach(async () => {
    await installSceneFrameDriver(sourcePage);
  });
  afterEach(() => {
    for (const name of [
      SCENE_FRAME_DRIVER_GLOBAL,
      VIDEO_PAUSED_DIALS_GLOBAL,
      TRACE_GLOBAL,
      "HTMLVideoElement",
      "document",
    ]) {
      delete globalThis[name];
    }
  });

  it("the rig registers the first-render bound the cell passes in", () => {
    assert.equal(VIDEO_RIG.dials.paused.firstRenderMaxMs, 30_000);
  });

  it("a first render that arrives late but within the bound is waited for, and the surface is then judged drawn", async () => {
    const dials = installDemoState();
    const scene = makeScene();
    const timer = setTimeout(() => firstRender(dials, scene), 300);
    try {
      const result = await awaitSurfaceDrawn({
        ...ARGS,
        firstRenderMs: 5_000,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.firstRender.renderedAtEntry, false);
      assert.ok(
        result.firstRender.waitedMs >= 250 &&
          result.firstRender.waitedMs < 5_000,
        `waited ${result.firstRender.waitedMs} ms`,
      );
      assert.equal(result.drive.outcome, "done");
      assert.ok(scene.frames > ARGS.settleFrames, `${scene.frames} frames`);
    } finally {
      clearTimeout(timer);
    }
  });

  it("no first render within the bound refuses with no-scene-rendered, after waiting the bound", async () => {
    installDemoState();
    const started = performance.now();
    const result = await awaitSurfaceDrawn({ ...ARGS, firstRenderMs: 200 });
    const elapsed = performance.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-scene-rendered");
    assert.equal(result.firstRender.renderedAtEntry, false);
    assert.equal(result.firstRender.boundMs, 200);
    assert.ok(result.firstRender.waitedMs >= 200, JSON.stringify(result));
    assert.ok(elapsed < 2_000, `returned after ${elapsed} ms`);
  });

  it("the bound is the cell's deadline when that is shorter than the registered bound", async () => {
    installDemoState();
    const started = performance.now();
    const result = await awaitSurfaceDrawn({
      ...ARGS,
      deadlineMs: 150,
      firstRenderMs: 5_000,
    });
    assert.equal(result.reason, "no-scene-rendered");
    assert.equal(result.firstRender.boundMs, 150);
    assert.ok(performance.now() - started < 2_000);
  });

  it("a scene that rendered before the wait is driven without waiting", async () => {
    const dials = installDemoState();
    const scene = makeScene();
    firstRender(dials, scene);
    const result = await awaitSurfaceDrawn({ ...ARGS, firstRenderMs: 5_000 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.firstRender.renderedAtEntry, true);
    assert.ok(result.firstRender.waitedMs < 200);
    assert.equal(result.readyFromFrame, 1);
  });

  it("a late first render does not excuse the readiness conditions: a camera that never tracks still ends at the frame cap", async () => {
    const dials = installDemoState();
    const scene = makeScene({ tracking: false });
    const timer = setTimeout(() => firstRender(dials, scene), 100);
    try {
      const result = await awaitSurfaceDrawn({
        ...ARGS,
        maxFrames: 40,
        firstRenderMs: 5_000,
      });
      assert.equal(result.ok, false);
      assert.equal(result.drive.outcome, "frame-cap");
      assert.equal(result.readiness.cameraTracking, false);
      assert.equal(result.firstRender.renderedAtEntry, false);
    } finally {
      clearTimeout(timer);
    }
  });
});

describe("the moving video cell's spread band is judged on frame-matched captures", () => {
  const factor = VIDEO_RIG.dials.matchedSpread.factor;

  it("the rig registers the matched instant and the factor", () => {
    assert.equal(VIDEO_RIG.dials.matchedSpread.seconds, 5.5);
    assert.equal(factor, 2);
  });

  it("matched spreads within the factor meet the band; a placeholder-white WebGPU box does not", () => {
    const met = judgeMatchedSpread(
      { matched: { lumaStdDev: 36.05 } },
      { matched: { lumaStdDev: 35.94 } },
      factor,
    );
    assert.equal(met.met, true);
    assert.equal(met.min, 35.94 / 2);
    assert.equal(met.max, 35.94 * 2);
    const blank = judgeMatchedSpread(
      { matched: { lumaStdDev: 0.298 } },
      { matched: { lumaStdDev: 35.54 } },
      factor,
    );
    assert.equal(blank.met, false);
  });

  it("the band is void, never met or failed, when either renderer has no matched capture or WebGL's spread is 0", () => {
    for (const [webgpu, webgl] of [
      [{ matched: { lumaStdDev: null } }, { matched: { lumaStdDev: 30 } }],
      [{ matched: { lumaStdDev: 30 } }, {}],
      [{ matched: { lumaStdDev: 30 } }, { matched: { lumaStdDev: 0 } }],
    ]) {
      assert.equal(judgeMatchedSpread(webgpu, webgl, factor).met, null);
    }
  });

  it("a run whose first moving captures land on different frames is judged on the matched capture, not on the first", () => {
    // Job 11b: WebGPU's first capture was a title card (3.871) and WebGL's a
    // shot (35.546); the matched values are illustrative of one shared frame.
    const record = (renderer, first, matched) => ({
      scene: "video",
      rig: VIDEO_RIG.id,
      renderer,
      centerBox: { lumaStdDev: first, changedFraction: 1 },
      matched: { ok: true, lumaStdDev: matched },
    });
    const [pair] = pairStubTextureCells([
      record("webgl", 35.546, 30.2),
      record("webgpu", 3.871, 28.7),
    ]);
    assert.equal(pair.scene, "video");
    assert.equal(pair.lumaStdDev.webgpu, 3.871);
    assert.equal(pair.matchedSpread.webgpu, 28.7);
    assert.equal(pair.matchedSpread.webgl, 30.2);
    assert.equal(pair.matchedSpread.met, true);
  });
});
