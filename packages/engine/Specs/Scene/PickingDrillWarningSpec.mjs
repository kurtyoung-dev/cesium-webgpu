/**
 * Behavioural spec for the drill-pick stale-results warning.
 *
 * PROPOSED LOCATION: packages/engine/Specs/Scene/PickingDrillWarningSpec.mjs
 * Run:      node --test packages/engine/Specs/Scene/PickingDrillWarningSpec.mjs
 * Mutation: CESIUM_PICKING_MODULE=<file:// url of a mutated copy> node --test ...
 *
 * The warning carries two independent properties, and each needs its own kind
 * of evidence:
 *
 *   1. It must SURVIVE the release pragma strip. That is a build property, so
 *      it is asserted by running the SHIPPED stripper (scripts/build.js) over
 *      the source and checking the call is still there. A hand-rolled
 *      pragma-depth counter is a twin of the stripper and can disagree with it.
 *   2. It must actually FIRE, and only for a context without synchronous
 *      readback. That is a runtime property, so it is asserted by driving the
 *      real `Picking.prototype.drillPick` and observing the emission. Grepping
 *      the source for the guard cannot see this: a guard wrapped in an
 *      enclosing `if (false)`, or an `oneTimeWarning` shadowed by a local
 *      no-op, leaves every greppable token intact while the warning is dead.
 *
 * Phase ordering is load-bearing. `oneTimeWarning`
 * (packages/engine/Source/Core/oneTimeWarning.js:34) latches per identifier in
 * a module-private map with no reset hook, so the "does not warn" phase MUST
 * run before the "does warn" phase — after the latch trips, "did not warn"
 * would pass vacuously. Both live inside ONE test() so no runner can reorder
 * them, and `node --test` isolates each file in its own process so the latch
 * starts clean. If an earlier emission ever did trip it, phase B fails LOUD
 * rather than passing quietly.
 */
import assert from "node:assert/strict";
// Imported rather than taken from the global scope so the file lints under the
// engine Specs config, which supplies browser/jasmine globals, not Node's.
import console from "node:console";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "../../../../Tools/visual-regression/lib/engine-ts-resolver.mjs";
// REQUIRES a one-word change in scripts/build.js: `export function
// constructRegex(...)` and `export const pragmas = ...` (both are currently
// module-private at scripts/build.js:55 and :70). Zero behaviour change; it
// lets this spec strip with the real thing instead of a copy of it.
import { constructRegex, pragmas } from "../../../../scripts/build.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(HERE, "../../Source");

enableEngineTsResolution();

// Defaults to the shipped module. The override exists so a mutation run can
// point the same assertions at a deliberately broken copy and confirm they go
// red — a spec that has never been seen to fail has not been shown to measure
// anything. Precedent: packages/engine/Specs/Renderer/WebGPU/
// WebGPUPickFramebufferStatsSpec.mjs:47-55.
const PICKING_PATH = resolve(ENGINE_SOURCE, "Scene/Picking.js");
const MODULE_URL =
  process.env.CESIUM_PICKING_MODULE ?? pathToFileURL(PICKING_PATH).href;

const { default: Picking } = await import(MODULE_URL);
const { default: oneTimeWarning } = await import(
  pathToFileURL(resolve(ENGINE_SOURCE, "Core/oneTimeWarning.js")).href
);

const WARNING_CALL = 'oneTimeWarning(\n        "WebGPU.drillPick.staleResults"';
const WINDOW_POSITION = { x: 4, y: 7 };

/**
 * `new Picking(scene)` builds a real `Camera` and `View` from the scene
 * (Picking.js:70-83), which needs a live Scene — a stub cannot reach the
 * constructor. `drillPick` itself reads only `scene.context` and calls
 * `this.pick`, so the spec links a bare object to the real prototype and stubs
 * that one collaborator. The method under test, the module-level drill loop it
 * calls, and the warning call site are all shipped code.
 */
function makePicking(pickResults) {
  const picking = Object.create(Picking.prototype);
  picking.pickCalls = [];
  picking.pick = function (scene, windowPosition, width, height, limit) {
    picking.pickCalls.push({ scene, windowPosition, width, height, limit });
    return pickResults.length > 0 ? pickResults.shift() : [];
  };
  return picking;
}

function fakeScene(supportsSynchronousReadback) {
  return { context: { supportsSynchronousReadback } };
}

/** Captures every console.warn — the sole emission point of oneTimeWarning. */
function captureWarnings(fn) {
  const captured = [];
  const realWarn = console.warn;
  console.warn = (...args) => captured.push(args.map(String).join(" "));
  try {
    return { value: fn(), captured };
  } finally {
    console.warn = realWarn;
  }
}

function drill(picking, supportsSynchronousReadback) {
  return captureWarnings(() =>
    Picking.prototype.drillPick.call(
      picking,
      fakeScene(supportsSynchronousReadback),
      WINDOW_POSITION,
      2,
      3,
      3,
    ),
  );
}

test("drillPick warns only for contexts without synchronous readback", () => {
  // --- Phase A: WebGL-shaped context. Must run first, before the latch. -----
  const readbackPicking = makePicking([]);
  const phaseA = drill(readbackPicking, true);
  assert.deepEqual(
    phaseA.captured,
    [],
    "a context with synchronous readback must not warn",
  );
  assert.equal(
    readbackPicking.pickCalls.length,
    1,
    "drillPick must still drive the pick loop on the readback path",
  );

  // --- Phase B: WebGPU-shaped context. The warning must actually fire. ------
  const phaseB = drill(makePicking([]), false);
  assert.equal(
    phaseB.captured.length,
    1,
    "a context without synchronous readback must emit exactly one warning",
  );
  assert.match(
    phaseB.captured[0],
    /drillPickAsync/,
    "the warning must steer the caller to the async API",
  );

  // --- Phase C: the emission is latched, not per-call. ----------------------
  const phaseC = drill(makePicking([]), false);
  assert.deepEqual(
    phaseC.captured,
    [],
    "the stale-results warning must not repeat on every drill pick",
  );
});

test("the warning capture mechanism itself is live (positive control)", () => {
  // Proves phase A's empty-array assertion is a real observation and not the
  // artefact of a spy that never sees anything.
  const control = captureWarnings(() =>
    oneTimeWarning(
      `spec-control-${Math.random()}`,
      "control message for the drill-pick warning spec",
    ),
  );
  assert.equal(control.captured.length, 1);
  assert.match(control.captured[0], /control message/);
});

test("drillPick drives the drill loop and restores show state", () => {
  const primitive = { show: true };
  const picking = makePicking([[{ primitive: primitive, id: undefined }], []]);
  const { value } = drill(picking, false);

  assert.equal(picking.pickCalls.length, 2, "the drill loop must re-pick");
  assert.equal(
    picking.pickCalls[1].limit,
    1,
    "the second iteration must ask for the remaining limit",
  );
  assert.deepEqual(
    value.map((object) => object.primitive),
    [primitive],
    "drillPick must return the picked objects",
  );
  assert.equal(
    primitive.show,
    true,
    "drillPick must restore show on every primitive it hid",
  );
});

test("the warning survives the release pragma strip", () => {
  // Runs the SHIPPED stripper rather than a re-implementation of it, so the
  // assertion cannot drift from what `npx gulp buildRelease` actually emits.
  const source = readFileSync(PICKING_PATH, "utf8").replace(/\r\n?/g, "\n");
  assert.ok(
    source.includes(WARNING_CALL),
    "the stale-results warning must exist in Picking.js",
  );

  let stripped = source;
  for (const key of Object.keys(pragmas)) {
    stripped = stripped.replace(constructRegex(key, pragmas[key]), "");
  }
  assert.ok(
    stripped.includes(WARNING_CALL),
    "the stale-results warning must survive the release pragma strip — " +
      "a caller on a backend without synchronous readback gets silently " +
      "wrong drillPick results and needs this message in production",
  );
});
