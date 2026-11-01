// landing-page-frames.spec.mjs - the landing probe's driven frame is a widget frame.
// @purpose Pins lib/landing-page-frames.mjs: the in-page frame driver runs, per frame, `scene.initializeFrame()` then `scene.render(clock.currentTime)` and waits one animation frame, never ticking the frozen clock, so that with the viewer's own render loop stopped the globe height is refreshed and a wheel notch reaches the camera controller; `settleFramesOf` turns a rig's readiness into a frame count; `pageNow` reads page time.
// @status ACTIVE
//
// NO BROWSER. The frame driver runs against the shared fake world
// (`fixtures/dive-gate-fake-world.mjs`), whose scene refreshes `globeHeight` and
// runs the controller only in `initializeFrame()`, as `Scene.js` does. The world
// answers nothing the cases read: a camera moves, or a height appears, only if the
// driver under test called `initializeFrame()`.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeDiveGateFakeWorld } from "./fixtures/dive-gate-fake-world.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import * as frames from "./lib/landing-page-frames.mjs";

const FRAMES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "lib",
  "landing-page-frames.mjs",
);

/** Run `count` frames of `driver` in a world; the world records the order of calls. */
async function drive(driver, count, worldOptions = {}) {
  const world = makeDiveGateFakeWorld({ surface: 43, ...worldOptions });
  const order = [];
  const { initializeFrame, render } = world.scene;
  world.scene.initializeFrame = function loggedInitializeFrame() {
    order.push("initializeFrame");
    return initializeFrame.call(this);
  };
  world.scene.render = function loggedRender(time) {
    order.push("render");
    return render.call(this, time);
  };
  const returned = await world.page.evaluate(driver, { frames: count });
  return { world, order, returned };
}

test("each driven frame is a widget frame: initializeFrame, then render at the frozen clock, then one animation frame", async () => {
  const before = globalThis.requestAnimationFrame;
  const { world, order, returned } = await drive(frames.pageRenderFrames, 3);
  assert.equal(returned, 3);
  assert.deepEqual(order, [
    "initializeFrame",
    "render",
    "initializeFrame",
    "render",
    "initializeFrame",
    "render",
  ]);
  assert.equal(world.seen.animationFrames, 3);
  assert.equal(world.seen.clockTicks, 0, "the stage froze the clock");
  assert.deepEqual(
    world.seen.renders,
    new Array(3).fill(world.viewer.clock.currentTime),
  );
  assert.equal(globalThis.requestAnimationFrame, before, "globals restored");
  assert.equal(globalThis.viewer, undefined, "globals restored");
});

test("with the loop stopped, the driver refreshes the globe height", async () => {
  const { world } = await drive(frames.pageRenderFrames, 1);
  assert.equal(world.scene.globeHeight, 43);
});

test("a wheel notch queued before a frame moves the camera in that frame", async () => {
  const world = makeDiveGateFakeWorld({ surface: 43, startHeight: 150 });
  await world.page.evaluate(frames.pageRenderFrames, { frames: 1 });
  const placed = world.camera.height;
  await world.page.mouse.wheel(0, -120);
  assert.equal(world.camera.height, placed, "input waits for a frame");
  await world.page.evaluate(frames.pageRenderFrames, { frames: 1 });
  assert.ok(world.camera.height < placed, "the frame ran the controller");
});

test("settleFramesOf: settleFrames is taken as given, settleMs is about 60 frames a second, at least one", () => {
  assert.equal(
    frames.settleFramesOf({ readiness: { kind: "settleFrames", frames: 12 } }),
    12,
  );
  assert.equal(
    frames.settleFramesOf({ readiness: { kind: "settleMs", ms: 1000 } }),
    60,
  );
  assert.equal(
    frames.settleFramesOf({ readiness: { kind: "settleMs", ms: 500 } }),
    30,
  );
  assert.equal(frames.settleFramesOf({}), 60);
  assert.equal(
    frames.settleFramesOf({ readiness: { kind: "settleMs", ms: 1 } }),
    1,
  );
});

test("pageNow is page time: a finite number of milliseconds that does not go backwards", () => {
  const first = frames.pageNow();
  const second = frames.pageNow();
  assert.ok(Number.isFinite(first) && first >= 0);
  assert.ok(second >= first);
});

// ---------------------------------------------------------------------------
// INERTNESS
// ---------------------------------------------------------------------------

test("INERTNESS: with the initializeFrame call unreachable, the globe height stays stale and the wheel never reaches the camera", async () => {
  const mutated = await importMutated(FRAMES_PATH, [
    [
      "viewer.scene.initializeFrame();",
      "false && viewer.scene.initializeFrame();",
    ],
  ]);
  const { world, order } = await drive(mutated.pageRenderFrames, 3);
  assert.deepEqual(order, ["render", "render", "render"]);
  assert.equal(world.scene.globeHeight, undefined);
  await world.page.mouse.wheel(0, -120);
  const height = world.camera.height;
  await world.page.evaluate(mutated.pageRenderFrames, { frames: 2 });
  assert.equal(world.camera.height, height);
});

test("INERTNESS: with the frozen time unreachable, the frame renders at no time", async () => {
  const mutated = await importMutated(FRAMES_PATH, [
    [
      "viewer.scene.render(viewer.clock.currentTime);",
      "viewer.scene.render();",
    ],
  ]);
  const { world } = await drive(mutated.pageRenderFrames, 2);
  assert.notDeepEqual(
    world.seen.renders,
    new Array(2).fill(world.viewer.clock.currentTime),
  );
});
