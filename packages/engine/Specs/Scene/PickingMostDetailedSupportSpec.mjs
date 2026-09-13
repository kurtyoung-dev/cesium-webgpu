/**
 * Behavioural spec for three picking changes:
 *
 *   A. `GraphicsContext#supportsOffscreenRayDepthReadback` and the two
 *      `Scene#*MostDetailedSupported` getters built on it, including the
 *      requirement that the SYNCHRONOUS `sampleHeightSupported` /
 *      `clampToHeightSupported` keep reporting `true` on a backend that lacks
 *      the offscreen producer — the synchronous calls work there, and debug
 *      guards throw when those two are false.
 *   B. `Picking#clampToHeightMostDetailed` no longer handing the pick the
 *      caller's own array element as an out-parameter.
 *   C. `Picking#sampleHeightMostDetailed` preserving a successful height when
 *      multiple array entries refer to the same caller-owned object.
 *
 * Run:  node --test packages/engine/Specs/Scene/PickingMostDetailedSupportSpec.mjs
 *
 * The file is `.mjs` on purpose. `scripts/build.js` globs
 * `packages/engine/Specs/**\/*Spec.js` into the Karma SpecList and esbuild
 * bundles the result for a browser, so a `node:test` import behind a `.js`
 * suffix would break the whole engine spec bundle.
 *
 * Everything under test is the SHIPPED module. Two loader hooks make that
 * possible from plain Node, and neither one touches the code being asserted:
 *
 *   - Generated GLSL/WGSL string modules under `Source/Shaders/` are build
 *     output and are absent from a clean checkout. Any missing `Shaders/*.js`
 *     resolves to an empty-string module — the same substitution the
 *     variant-alias build plugin makes, and shader text is not on any path this
 *     spec exercises.
 *   - Node's TypeScript support elides only imports marked `type`, so engine
 *     `.ts` modules that import an interface without the keyword fail to link.
 *     A load hook appends `export const <Name> = undefined;` for every
 *     `export interface` / `export type` in a `.ts` file. Those names have no
 *     runtime value by construction, so nothing real is shadowed.
 *
 * Enums additionally need `--experimental-transform-types`; rather than make
 * the caller remember a flag, the file re-executes itself once with it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks } from "node:module";
import process from "node:process";
import test from "node:test";
import { setTimeout } from "node:timers";
import { URL, fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const RETRY_FLAG = "CESIUM_SPEC_TS_TRANSFORM_RETRY";

if (process.features.typescript !== "transform" && !process.env[RETRY_FLAG]) {
  const env = { ...process.env, [RETRY_FLAG]: "1" };
  // `node --test` marks its file children with NODE_TEST_CONTEXT; inheriting it
  // makes the re-executed process report nothing and exit 0, which would turn
  // every assertion below into a silent pass.
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", SELF],
    { stdio: "inherit", env: env },
  );
  process.exit(child.status ?? 1);
}

const EMPTY_SHADER_MODULE = "data:text/javascript,export default %22%22;";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      typeof context.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      const target = fileURLToPath(new URL(specifier, context.parentURL));
      if (!fs.existsSync(target) && /[\\/]Shaders[\\/]/.test(target)) {
        return { url: EMPTY_SHADER_MODULE, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith(".ts") || !loaded.source) {
      return loaded;
    }
    const source = loaded.source.toString();
    const typeOnlyExports = new Set();
    const declaration =
      /^export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z0-9_$]+)/gm;
    let match = declaration.exec(source);
    while (match !== null) {
      typeOnlyExports.add(match[1]);
      match = declaration.exec(source);
    }
    if (typeOnlyExports.size === 0) {
      return loaded;
    }
    const placeholders = [...typeOnlyExports]
      .map((name) => `export const ${name} = undefined;`)
      .join("\n");
    loaded.source = `${source}\n${placeholders}\n`;
    return loaded;
  },
});

const { enableEngineTsResolution } = await import(
  new URL(
    "../../../../Tools/visual-regression/lib/engine-ts-resolver.mjs",
    import.meta.url,
  ).href
);
enableEngineTsResolution();

const engine = (relative) =>
  import(new URL(`../../Source/${relative}`, import.meta.url).href);

const { default: Picking } = await engine("Scene/Picking.js");
const {
  getRayForSampleHeight,
  getRayForClampToHeight,
  getHeightFromCartesian,
  clampToHeightMostDetailed,
} = await engine("Scene/PickingRayHelpers.js");
const { default: Scene } = await engine("Scene/Scene.js");
const { default: GraphicsContext } = await engine(
  "Renderer/GraphicsContext.ts",
);
const { default: Context } = await engine("Renderer/Context.js");
const { default: WebGPUContext } = await engine(
  "Renderer/WebGPU/WebGPUContext.ts",
);
const { default: Cartesian3 } = await engine("Core/Cartesian3.js");
const { default: PickDepth } = await engine("Scene/PickDepth.js");
const { default: Cartographic } = await engine("Core/Cartographic.js");
const { default: Ray } = await engine("Core/Ray.js");
const { default: Ellipsoid } = await engine("Core/Ellipsoid.js");
const { default: BoundingRectangle } = await engine(
  "Core/BoundingRectangle.js",
);
const { default: SceneMode } = await engine("Scene/SceneMode.js");

// ─────────────────────────────────────────────────────────── slice A ────────

const CAPABILITY = "supportsOffscreenRayDepthReadback";

/** Reads a getter off the real prototype chain, so overrides resolve for real. */
function read(prototype, property, instance) {
  return Reflect.get(prototype, property, instance);
}

function contextOf(ContextClass) {
  const context = Object.create(ContextClass.prototype);
  // Both concrete classes compute `depthTexture` from live GPU state that does
  // not exist here. Shadowing it with `true` is what every caller sees on a
  // machine that can render at all, and it is the term these getters AND the
  // pre-existing synchronous ones already share.
  Object.defineProperty(context, "depthTexture", { value: true });
  return context;
}

function sceneOn(context) {
  const scene = Object.create(Scene.prototype);
  scene._context = context;
  return scene;
}

test("the offscreen ray-depth capability is true by default and on WebGL", () => {
  const base = Object.create(GraphicsContext.prototype);
  assert.equal(
    read(GraphicsContext.prototype, CAPABILITY, base),
    true,
    "the base capability must default to true",
  );

  assert.equal(
    Object.getOwnPropertyDescriptor(Context.prototype, CAPABILITY),
    undefined,
    "the WebGL Context must NOT override the capability — inheriting the " +
      "base `true` is what keeps every WebGL picking path unchanged",
  );
  assert.equal(
    read(Context.prototype, CAPABILITY, contextOf(Context)),
    true,
    "a WebGL context must report the capability as supported",
  );

  // Positive control: own-override detection is a live observation, not an
  // artefact of asking for a property no class defines.
  assert.notEqual(
    Object.getOwnPropertyDescriptor(
      WebGPUContext.prototype,
      "supportsSynchronousReadback",
    ),
    undefined,
    "WebGPUContext is expected to own a supportsSynchronousReadback override",
  );
});

test("WebGPU reports the offscreen ray-depth capability as supported", () => {
  // It read `false` for the renderer's whole history: the pick pass published
  // no depth for the offscreen ray render, so every `*MostDetailed` height
  // query resolved undefined. The pick pass publishes it now (Batch 1477), on
  // demand, and this getter is how the picking code and the Scene getters
  // below learn that.
  assert.notEqual(
    Object.getOwnPropertyDescriptor(WebGPUContext.prototype, CAPABILITY),
    undefined,
    "WebGPUContext must state the capability explicitly — this is the getter " +
      "whose value changed, and an inherited default hides that",
  );
  assert.equal(
    read(WebGPUContext.prototype, CAPABILITY, contextOf(WebGPUContext)),
    true,
    "a WebGPU context must report the offscreen ray depth as readable",
  );

  // The capability it must NOT have taken with it: the readback is still
  // asynchronous, which is what keeps the synchronous `pickFromRay` position
  // unavailable there.
  assert.equal(
    read(
      WebGPUContext.prototype,
      "supportsSynchronousReadback",
      contextOf(WebGPUContext),
    ),
    false,
    "synchronous readback must stay false on WebGPU",
  );
});

test("both backends report the *MostDetailed variants as supported", () => {
  const webgl = sceneOn(contextOf(Context));
  const webgpu = sceneOn(contextOf(WebGPUContext));

  // Both backends recover the depth from the offscreen ray render; WebGL reads
  // it back in the call and WebGPU awaits it (slice D). Both resolve real
  // values, so both report supported.
  for (const [label, scene] of [
    ["WebGL", webgl],
    ["WebGPU", webgpu],
  ]) {
    assert.equal(
      scene.sampleHeightMostDetailedSupported,
      true,
      `sampleHeightMostDetailedSupported must be true on ${label}`,
    );
    assert.equal(
      scene.clampToHeightMostDetailedSupported,
      true,
      `clampToHeightMostDetailedSupported must be true on ${label}`,
    );
  }

  // And they must report it FROM the capability rather than from a constant:
  // a context without the producer still reads false on both getters.
  const noProducer = sceneOn({ depthTexture: true, [CAPABILITY]: false });
  assert.equal(noProducer.sampleHeightMostDetailedSupported, false);
  assert.equal(noProducer.clampToHeightMostDetailedSupported, false);

  // The synchronous pair must NOT move. Debug guards throw when these are
  // false, and the synchronous sampleHeight / clampToHeight do work on WebGPU
  // by reusing the main scene depth rather than an offscreen ray render.
  for (const [label, scene] of [
    ["WebGL", webgl],
    ["WebGPU", webgpu],
  ]) {
    assert.equal(
      scene.sampleHeightSupported,
      true,
      `sampleHeightSupported must stay true on ${label}`,
    );
    assert.equal(
      scene.clampToHeightSupported,
      true,
      `clampToHeightSupported must stay true on ${label}`,
    );
  }
});

test("the *MostDetailed getters read the capability, not a hard-coded value", () => {
  // Drives the real Scene getters across the whole truth table with a plain
  // context, so a getter that ignored either of its two terms fails here.
  for (const depthTexture of [true, false]) {
    for (const capability of [true, false]) {
      const scene = sceneOn({
        depthTexture: depthTexture,
        [CAPABILITY]: capability,
      });
      const expected = depthTexture && capability;
      const where = `depthTexture=${depthTexture} capability=${capability}`;
      assert.equal(scene.sampleHeightMostDetailedSupported, expected, where);
      assert.equal(scene.clampToHeightMostDetailedSupported, expected, where);
    }
  }
});

// ─────────────────────────────────────────────────────────── slice B ────────

const NEAR = 10.0;
const FAR = 1000.0;
const SUBJECT = Cartesian3.fromDegrees(-75.0, 40.0, 0.0);

function distanceFor(depth) {
  return NEAR + depth * (FAR - NEAR);
}

/**
 * `Picking` builds a real Camera and View in its constructor, which needs a
 * live Scene. `clampToHeightMostDetailed` reaches only the collaborators stubbed
 * below, so the spec links a bare object to the real prototype. The method under
 * test, the batch loop, the ray construction, the drill loop and the
 * position-recovery arithmetic are all shipped code; only the render and the
 * depth sample are simulated.
 */
function makeHarness(depths) {
  const remainingDepths = depths.slice();
  const postRenderListeners = [];

  const scene = {
    mode: SceneMode.SCENE3D,
    ellipsoid: Ellipsoid.WGS84,
    sampleHeightSupported: true,
    clampToHeightSupported: true,
    opaqueFrustumNearOffset: 1.0,
    primitives: { length: 0 },
    jobScheduler: {
      disableThisFrame() {},
    },
    frameState: { passes: {} },
    context: {
      depthTexture: true,
      supportsSynchronousReadback: true,
      uniformState: {
        update() {},
      },
      endFrame() {},
    },
    updateFrameState() {},
    updateEnvironment() {},
    updateAndExecuteCommands() {},
    resolveFramebuffers() {},
    requestRender() {
      setTimeout(function () {
        for (const listener of postRenderListeners.splice(0)) {
          listener();
        }
      }, 0);
    },
    postRender: {
      addEventListener(callback) {
        postRenderListeners.push(callback);
        return function () {
          const index = postRenderListeners.indexOf(callback);
          if (index >= 0) {
            postRenderListeners.splice(index, 1);
          }
        };
      },
    },
  };
  scene.defaultView = { label: "default" };
  scene.view = scene.defaultView;

  const picking = Object.create(Picking.prototype);
  picking._mostDetailedRayPicks = [];
  picking._pickOffscreenView = {
    viewport: new BoundingRectangle(0.0, 0.0, 1.0, 1.0),
    frustumCommandsList: [{ near: NEAR, far: FAR }],
    camera: {
      positionWC: new Cartesian3(),
      directionWC: new Cartesian3(),
      upWC: new Cartesian3(),
      frustum: {
        width: 0.0,
        computeCullingVolume() {
          return { stub: true };
        },
      },
    },
    pickFramebuffer: {
      begin() {
        return {};
      },
      // No picked object: `getRayIntersection` then reports a hit purely from
      // the recovered position, which is the shape this batch cares about.
      end() {
        return [undefined];
      },
    },
  };
  picking.getPickDepth = function () {
    return {
      getDepth() {
        return remainingDepths.shift();
      },
    };
  };

  return { scene, picking };
}

/** The position the shipped code must produce for `depth` at `origin`. */
function expectedPosition(scene, origin, depth) {
  return Ray.getPoint(
    getRayForClampToHeight(scene, origin),
    distanceFor(depth),
  );
}

function assertAt(actual, expected, message) {
  assert.ok(
    Cartesian3.equals(actual, expected),
    `${message}\n  actual:   ${actual}\n  expected: ${expected}`,
  );
}

test("aliased entries do not overwrite each other's clamped position", async () => {
  const shared = Cartesian3.clone(SUBJECT);
  const originalValue = Cartesian3.clone(SUBJECT);
  const cartesians = [shared, shared];
  const { scene, picking } = makeHarness([0.25, 0.75]);

  const promise = Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    cartesians,
  );

  // The picks already ran (no tilesets to wait for), so this is the in-flight
  // observation: not one caller-owned object may have been written yet.
  assertAt(
    shared,
    originalValue,
    "the caller's object must be untouched while the batch is running",
  );

  const result = await promise;
  assert.equal(result, cartesians, "the caller's array must be returned");

  const first = expectedPosition(scene, originalValue, 0.25);
  const second = expectedPosition(scene, originalValue, 0.75);
  assert.ok(
    !Cartesian3.equals(first, second),
    "the two simulated picks must differ, or this spec proves nothing",
  );

  assertAt(cartesians[0], first, "entry 0 must keep its own clamped position");
  assertAt(cartesians[1], second, "entry 1 must keep its own clamped position");
  assert.notEqual(
    cartesians[0],
    cartesians[1],
    "aliased entries must resolve to independent objects, or a later write " +
      "through one of them silently changes the other",
  );
});

test("distinct entries are still clamped in place", async () => {
  const first = Cartesian3.clone(SUBJECT);
  const second = Cartesian3.clone(SUBJECT);
  const originalValue = Cartesian3.clone(SUBJECT);
  const cartesians = [first, second];
  const { scene, picking } = makeHarness([0.25, 0.75]);

  const promise = Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    cartesians,
  );
  assertAt(first, originalValue, "entry 0 must not be written in flight");
  assertAt(second, originalValue, "entry 1 must not be written in flight");

  await promise;

  assert.equal(
    cartesians[0],
    first,
    "an entry with its own object must still be clamped in place",
  );
  assert.equal(
    cartesians[1],
    second,
    "an entry with its own object must still be clamped in place",
  );
  assertAt(cartesians[0], expectedPosition(scene, originalValue, 0.25));
  assertAt(cartesians[1], expectedPosition(scene, originalValue, 0.75));
});

test("an entry with no geometry beneath it becomes undefined", async () => {
  const hit = Cartesian3.clone(SUBJECT);
  const miss = Cartesian3.clone(SUBJECT);
  const originalValue = Cartesian3.clone(SUBJECT);
  const cartesians = [hit, miss];
  // The second pick reports no usable depth.
  const { scene, picking } = makeHarness([0.5, undefined]);

  await Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    cartesians,
  );

  assertAt(cartesians[0], expectedPosition(scene, originalValue, 0.5));
  assert.equal(
    cartesians[1],
    undefined,
    "the documented contract sets unclampable entries to undefined",
  );
  assertAt(
    miss,
    originalValue,
    "an unclampable entry's object must be left as the caller supplied it",
  );
});

test("the ray-pick helper never writes an object passed to it", async () => {
  const { scene, picking } = makeHarness([0.5]);
  const target = Cartesian3.clone(SUBJECT);
  const originalValue = Cartesian3.clone(SUBJECT);
  const trespassTarget = new Cartesian3(1.0, 2.0, 3.0);
  const trespassValue = Cartesian3.clone(trespassTarget);

  // A caller-shaped out-parameter in the position the removed one occupied.
  const clamped = await clampToHeightMostDetailed(
    picking,
    scene,
    target,
    undefined,
    undefined,
    trespassTarget,
  );

  assertAt(
    clamped,
    expectedPosition(scene, originalValue, 0.5),
    "the helper must still return the clamped position",
  );
  assert.notEqual(
    clamped,
    trespassTarget,
    "the helper must not adopt an object handed to it as its result",
  );
  assert.notEqual(
    clamped,
    target,
    "the helper must not return the input object",
  );
  assertAt(
    trespassTarget,
    trespassValue,
    "the helper must not write through a trailing argument",
  );
  assertAt(target, originalValue, "the helper must not write its input");
});

// ─────────────────────────────────────────────────────────── slice C ────────

function sampleSubject(height) {
  return Cartographic.fromDegrees(-75.0, 40.0, height);
}

function expectedHeight(scene, cartographic, depth) {
  const position = Ray.getPoint(
    getRayForSampleHeight(scene, cartographic),
    distanceFor(depth),
    new Cartesian3(),
  );
  return getHeightFromCartesian(scene, position);
}

test("a failed alias cannot erase a successful sampled height", async () => {
  const shared = sampleSubject(125.0);
  const original = Cartographic.clone(shared);
  const positions = [shared, shared];
  const { scene, picking } = makeHarness([0.25, undefined]);

  const result = await Picking.prototype.sampleHeightMostDetailed.call(
    picking,
    scene,
    positions,
  );

  const expected = expectedHeight(scene, original, 0.25);
  assert.notEqual(
    expected,
    undefined,
    "the successful control sample must produce a height",
  );
  assert.notEqual(
    expected,
    original.height,
    "the successful control sample must change the starting height",
  );
  assert.equal(result, positions, "the caller's array must be returned");
  assert.equal(result[0], shared, "entry 0 must keep the caller's object");
  assert.equal(result[1], shared, "entry 1 must keep the caller's object");
  assert.equal(
    shared.height,
    expected,
    "a later failed alias must not erase the successful height",
  );
});

test("a successful alias replaces an earlier failed sample", async () => {
  const shared = sampleSubject(125.0);
  const original = Cartographic.clone(shared);
  const positions = [shared, shared];
  const { scene, picking } = makeHarness([undefined, 0.25]);

  const result = await Picking.prototype.sampleHeightMostDetailed.call(
    picking,
    scene,
    positions,
  );

  const expected = expectedHeight(scene, original, 0.25);
  assert.notEqual(
    expected,
    undefined,
    "the successful control sample must produce a height",
  );
  assert.notEqual(
    expected,
    original.height,
    "the successful control sample must change the starting height",
  );
  assert.equal(result, positions, "the caller's array must be returned");
  assert.equal(result[0], shared, "entry 0 must keep the caller's object");
  assert.equal(result[1], shared, "entry 1 must keep the caller's object");
  assert.equal(
    shared.height,
    expected,
    "a successful alias must replace the earlier failed sample",
  );
});

test("the last successful alias determines the sampled height", async () => {
  const shared = sampleSubject(125.0);
  const original = Cartographic.clone(shared);
  const positions = [shared, shared];
  const { scene, picking } = makeHarness([0.25, 0.5]);

  const result = await Picking.prototype.sampleHeightMostDetailed.call(
    picking,
    scene,
    positions,
  );

  const firstHeight = expectedHeight(scene, original, 0.25);
  const lastHeight = expectedHeight(scene, original, 0.5);
  assert.notEqual(
    firstHeight,
    lastHeight,
    "the successful control samples must produce different heights",
  );
  assert.equal(result, positions, "the caller's array must be returned");
  assert.equal(result[0], shared, "entry 0 must keep the caller's object");
  assert.equal(result[1], shared, "entry 1 must keep the caller's object");
  assert.equal(
    shared.height,
    lastHeight,
    "the last successful alias must determine the final height",
  );
});

test("distinct sampled entries keep their values and identities", async () => {
  const hit = sampleSubject(125.0);
  const miss = Cartographic.fromDegrees(-74.0, 39.0, 250.0);
  const originalHit = Cartographic.clone(hit);
  const originalMiss = Cartographic.clone(miss);
  const positions = [hit, miss];
  const { scene, picking } = makeHarness([0.25, undefined]);

  const result = await Picking.prototype.sampleHeightMostDetailed.call(
    picking,
    scene,
    positions,
  );

  assert.equal(result, positions, "the caller's array must be returned");
  assert.equal(result[0], hit, "a successful entry must keep its object");
  assert.equal(result[1], miss, "a failed entry must keep its object");
  assert.equal(hit.longitude, originalHit.longitude);
  assert.equal(hit.latitude, originalHit.latitude);
  assert.equal(hit.height, expectedHeight(scene, originalHit, 0.25));
  assert.equal(miss.longitude, originalMiss.longitude);
  assert.equal(miss.latitude, originalMiss.latitude);
  assert.equal(
    miss.height,
    undefined,
    "a failed non-aliased sample must still write undefined",
  );
});

test("shared entries remain undefined when every sample fails", async () => {
  const shared = sampleSubject(125.0);
  const positions = [shared, shared];
  const { scene, picking } = makeHarness([undefined, undefined]);

  const result = await Picking.prototype.sampleHeightMostDetailed.call(
    picking,
    scene,
    positions,
  );

  assert.equal(result, positions, "the caller's array must be returned");
  assert.equal(result[0], shared, "entry 0 must keep the caller's object");
  assert.equal(result[1], shared, "entry 1 must keep the caller's object");
  assert.equal(
    shared.height,
    undefined,
    "an all-failed shared sample must report the honest failure",
  );
});

// ─────────────────────────────────────────────────────────── slice D ────────
//
// The offscreen ray-depth readback the `*MostDetailed` height queries take on a
// backend whose readback cannot complete inside the call.
//
// The behaviour under test is the one the demo depends on: a batch of points
// must each resolve to a real position, waiting for a depth that is only
// readable after the frame is submitted. Before this route existed the pick
// pass published no readable depth at all, the synchronous recovery returned
// `undefined` for every point, and the caller's documented contract turned that
// into an array of holes — which is what `Cartesian3.pack` died on in
// `sample-height-from-3d-tiles`.
//
// Simulated here: the GPU render and the depth it publishes. Everything else is
// shipped code — the request flag, the per-slice loop, the distance arithmetic,
// the drill loop and its `show` restoration, and (in the last two tests) the
// real `PickDepth` queue over a fake device.

globalThis.GPUBufferUsage ??= { COPY_DST: 1, MAP_READ: 2 };
globalThis.GPUMapMode ??= { READ: 1 };

const CANVAS_WIDTH = 1024;
const CANVAS_HEIGHT = 768;
/** Readback latency, in macrotasks. Nothing inside one microtask drain. */
const READBACK_TICKS = 3;

const isDefined = (value) => value !== undefined && value !== null;

// The offscreen ray camera's own frustum -- the frame an asynchronous-readback
// backend actually rasterises in, because it bakes the projection into each
// command before any frustum slice exists. Deliberately WIDER than, and
// sharing no endpoint with, every slice band used below, so a reconstruction
// that reached for the slice instead produces a visibly different distance.
const ENCODE_NEAR = 0.1;
const ENCODE_FAR = 500000000.0;

function macrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The depth the fake device reports for a column of the depth texture. A whole
 * number of 1/255 steps, so it survives the RGBA8 pack the real producer uses,
 * and distinct per column, so a readback that answered for the wrong pixel is
 * visible rather than plausible.
 */
function depthForColumn(x) {
  return (((x * 7) % 200) + 20) / 255;
}

/**
 * A `PickDepth` stand-in as the WebGPU pick pass leaves it: holding a published
 * packed depth that only an awaited readback can reach. `getDepth` is the
 * synchronous query, and it answers `undefined` exactly as the real one does
 * before any readback has landed.
 */
function publishedPickDepth(depth, log) {
  return {
    getDepth() {
      log?.push("getDepth");
      return undefined;
    },
    async readDepthAsync() {
      log?.push("readDepthAsync");
      for (let i = 0; i < READBACK_TICKS; ++i) {
        await macrotask();
      }
      return depth;
    },
  };
}

/** The same stand-in for a backend that reads depth back synchronously. */
function synchronousPickDepth(depth, log) {
  return {
    getDepth() {
      log?.push("getDepth");
      return depth;
    },
    readDepthAsync() {
      log?.push("readDepthAsync");
      return Promise.resolve(depth);
    },
  };
}

/**
 * Drive the real `*MostDetailed` queries over a simulated offscreen render.
 *
 * @param {object} options Options.
 * @param {Array<{near: number, far: number, depth: number|undefined}>} options.slices
 *   One entry per frustum slice. `depth` is what that slice's published depth
 *   reads back as; `undefined` publishes no depth for the slice at all.
 * @param {boolean} [options.synchronous] Model a backend with synchronous
 *   readback (the WebGL shape): the slices' depths are readable in the call.
 * @param {boolean} [options.publish] Set false to model a producer that
 *   publishes nothing — the pre-fix state, and the shape of the inertness
 *   mutant.
 */
function rayHarness({
  slices,
  synchronous = false,
  publish = true,
  publishUntil = Infinity,
  perRenderDepths,
}) {
  let renders = 0;
  // The offscreen view's depth target, modelled as what it is: ONE texture
  // that every render overwrites. A readback resolves against whatever the
  // texture holds when it lands, not against a snapshot taken when it was
  // queued — which is the whole reason the offscreen ray picks are serialized.
  const sharedTarget = { depth: undefined };
  const log = [];
  const requestedDuringRender = [];
  const postRenderListeners = [];

  const context = {
    depthTexture: true,
    supportsSynchronousReadback: synchronous,
    supportsOffscreenRayDepthReadback: true,
    offscreenRayDepthRequested: false,
    uniformState: { update() {} },
    endFrame() {},
  };

  const view = {
    viewport: new BoundingRectangle(0.0, 0.0, 1.0, 1.0),
    frustumCommandsList: slices.map((slice) => ({
      near: slice.near,
      far: slice.far,
    })),
    pickDepths: [],
    camera: {
      positionWC: new Cartesian3(),
      directionWC: new Cartesian3(),
      upWC: new Cartesian3(),
      frustum: {
        width: 0.0,
        near: ENCODE_NEAR,
        far: ENCODE_FAR,
        computeCullingVolume() {
          return { stub: true };
        },
      },
    },
    pickFramebuffer: {
      begin() {
        return {};
      },
      // No picked object: the result is carried entirely by the recovered
      // position, which is the half this slice is about.
      end() {
        return [undefined];
      },
    },
  };

  const scene = {
    mode: SceneMode.SCENE3D,
    ellipsoid: Ellipsoid.WGS84,
    sampleHeightSupported: true,
    clampToHeightSupported: true,
    opaqueFrustumNearOffset: 0.9999,
    primitives: { length: 0 },
    jobScheduler: { disableThisFrame() {} },
    frameState: { passes: {} },
    canvas: { clientWidth: CANVAS_WIDTH, clientHeight: CANVAS_HEIGHT },
    drawingBufferWidth: CANVAS_WIDTH,
    drawingBufferHeight: CANVAS_HEIGHT,
    context: context,
    updateFrameState() {},
    updateEnvironment() {},
    updateAndExecuteCommands() {
      // What the pick pass sees when it decides whether to publish.
      requestedDuringRender.push(context.offscreenRayDepthRequested === true);
      renders++;
      if (!publish) {
        return;
      }
      if (renders > publishUntil) {
        // Device loss destroys the pick framebuffer's ray-depth targets
        // mid-batch: renders keep happening, publications stop, and the
        // instances already handed out point at destroyed textures.
        for (let i = 0; i < slices.length; ++i) {
          view.pickDepths[i] = {
            getDepth() {
              return undefined;
            },
            readDepthAsync() {
              // What `PickDepth._performDepthReadback` does when the copy or
              // the map throws: report no depth, never reject.
              return Promise.resolve(undefined);
            },
          };
        }
        return;
      }
      // The producer publishes only for a render that asked for it.
      if (!synchronous && context.offscreenRayDepthRequested !== true) {
        return;
      }
      if (isDefined(perRenderDepths)) {
        sharedTarget.depth =
          perRenderDepths[Math.min(renders - 1, perRenderDepths.length - 1)];
        view.pickDepths[0] = {
          getDepth() {
            return undefined;
          },
          async readDepthAsync() {
            for (let i = 0; i < READBACK_TICKS; ++i) {
              await macrotask();
            }
            return sharedTarget.depth;
          },
        };
        return;
      }
      for (let i = 0; i < slices.length; ++i) {
        const depth = slices[i].depth;
        if (!isDefined(depth)) {
          continue;
        }
        view.pickDepths[i] = synchronous
          ? synchronousPickDepth(depth, log)
          : publishedPickDepth(depth, log);
      }
    },
    resolveFramebuffers() {},
    requestRender() {
      setTimeout(function () {
        for (const listener of postRenderListeners.splice(0)) {
          listener();
        }
      }, 0);
    },
    postRender: {
      addEventListener(callback) {
        postRenderListeners.push(callback);
        return function () {
          const index = postRenderListeners.indexOf(callback);
          if (index >= 0) {
            postRenderListeners.splice(index, 1);
          }
        };
      },
    },
  };
  scene.defaultView = { label: "default" };
  scene.view = scene.defaultView;

  const picking = Object.create(Picking.prototype);
  picking._mostDetailedRayPicks = [];
  picking._pickOffscreenView = view;
  picking.getPickDepth = function (sceneArg, index) {
    assert.equal(
      sceneArg,
      scene,
      "the pick depth must be resolved against the scene under test",
    );
    return view.pickDepths[index];
  };

  return { scene, picking, view, context, log, requestedDuringRender };
}

/**
 * The position the shipped arithmetic must produce for a published depth.
 *
 * The two recoveries invert different frames, because the two backends
 * rasterise in different ones. A synchronous backend resolves its projection
 * per draw, so each slice's depth is in that slice's frame. An
 * asynchronous-readback backend bakes the projection into the command before
 * any slice exists, so every slice's depth is in the CAMERA's frame. Encoding
 * that difference here rather than in the assertions keeps each test stating
 * the behaviour it is about.
 *
 * CAVEAT, so nobody mistakes this for independent verification: the
 * asynchronous branch below is a transcription of `recoverRayPositionAsync`'s
 * own arithmetic, so a test that only compares against THIS oracle certifies
 * the formula against itself. The tests that actually carry the load are the
 * ones that do not use it — "the recovered distance follows the frame the
 * render encoded in" (an independently chosen true distance, plus a negative
 * control asserting the slice-band answer is NOT produced) and "each point
 * reads its OWN render's depth" (three independently chosen distances). The
 * oracle's remaining users are still live rather than inert: the encode-frame
 * mutants flip 7 and 5 of these tests.
 */
function expectedRayPosition(
  scene,
  target,
  sliceIndex,
  slices,
  synchronous = false,
) {
  const slice = slices[sliceIndex];
  let distance;
  if (synchronous) {
    const near =
      slice.near * (sliceIndex !== 0 ? scene.opaqueFrustumNearOffset : 1.0);
    distance = near + slice.depth * (slice.far - near);
  } else {
    distance = ENCODE_NEAR + slice.depth * (ENCODE_FAR - ENCODE_NEAR);
  }
  return Ray.getPoint(getRayForClampToHeight(scene, target), distance);
}

const ONE_SLICE = [{ near: 10.0, far: 1000.0, depth: 0.25 }];

// One slice holding a REALISTIC hit: `RAY_HIT_DEPTH` is the depth that encodes
// an 8.9 km ray distance in the camera's frame, and the slice band brackets it
// the way a real `frustumCommandsList` entry does. Tests that assert a value
// rather than mere definedness use this, so the number they check is a height
// a height query could actually return.
const RAY_HIT_DISTANCE = 8900.0;
const RAY_HIT_DEPTH =
  (RAY_HIT_DISTANCE - ENCODE_NEAR) / (ENCODE_FAR - ENCODE_NEAR);
const ONE_HIT_SLICE = [{ near: 8890.0, far: 8990.0, depth: RAY_HIT_DEPTH }];

test("a whole batch clamps, awaiting a readback that cannot land in the drain", async () => {
  const targets = [
    Cartesian3.fromDegrees(-75.0, 40.0, 0.0),
    Cartesian3.fromDegrees(-75.001, 40.0, 0.0),
    Cartesian3.fromDegrees(-75.002, 40.0, 0.0),
  ];
  const { scene, picking, log } = rayHarness({ slices: ONE_SLICE });
  // `clampToHeightMostDetailed` writes each result back through the caller's
  // own Cartesian, so the expectation must be built from what the ray was
  // before the call, not from the mutated object afterwards.
  const before = targets.map((target) => Cartesian3.clone(target));

  const result = await Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    targets.slice(),
  );

  assert.ok(
    log.includes("readDepthAsync"),
    "the query must have awaited a readback, not answered from a synchronous read",
  );
  for (let i = 0; i < targets.length; ++i) {
    assert.notEqual(
      result[i],
      undefined,
      `entry ${i} resolved undefined — the batch did not wait for its depth`,
    );
    const expected = expectedRayPosition(scene, before[i], 0, ONE_SLICE);
    assert.ok(
      Cartesian3.equalsEpsilon(result[i], expected, 1.0e-6),
      `entry ${i} clamped to the wrong distance\n  actual:   ${result[i]}\n  expected: ${expected}`,
    );
  }
});

test("the publication is requested for the render and not left on", async () => {
  const target = Cartesian3.fromDegrees(-75.0, 40.0, 0.0);
  const { scene, picking, context, requestedDuringRender } = rayHarness({
    slices: ONE_SLICE,
  });

  assert.equal(
    context.offscreenRayDepthRequested,
    false,
    "nothing may be requested before a query runs",
  );

  await Picking.prototype.clampToHeightMostDetailed.call(picking, scene, [
    target,
  ]);

  assert.ok(
    requestedDuringRender.length > 0 && requestedDuringRender.every(Boolean),
    "every offscreen ray render must carry the request; without it the pick " +
      "pass publishes no depth and this query is back to reading undefined",
  );
  assert.equal(
    context.offscreenRayDepthRequested,
    false,
    "the request must be lowered again, or every later ordinary pick pays for " +
      "a publication nobody reads",
  );
});

test("a slice with no hit is skipped and a farther slice still answers", async () => {
  const slices = [
    { near: 10.0, far: 1000.0, depth: 1.0 },
    { near: 1000.0, far: 100000.0, depth: 0.5 },
  ];
  const target = Cartesian3.fromDegrees(-75.0, 40.0, 0.0);
  const { scene, picking } = rayHarness({ slices });
  const before = Cartesian3.clone(target);

  const result = await Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    [target],
  );

  const expected = expectedRayPosition(scene, before, 1, slices);
  assert.notEqual(result[0], undefined, "the second slice's hit must be found");
  assert.ok(
    Cartesian3.equalsEpsilon(result[0], expected, 1.0e-6),
    `the farther slice's depth must be the one recovered\n  actual:   ${result[0]}\n  expected: ${expected}`,
  );
});

test("the recovered distance follows the frame the render encoded in", async () => {
  // The defect this pins: every point came back at its slice's near plane.
  //
  // A hit rasterised at distance D must be recovered at distance D. On this
  // backend the depth that reports D is `(D - cameraNear) / (cameraFar -
  // cameraNear)`, because the projection is baked into the command before any
  // slice exists. Inverting the SLICE band instead scales that depth by a
  // range four million times too small, and the answer collapses onto the
  // slice's near plane -- which is what 30 of 30 sampled points did.
  //
  // Stated as the behaviour rather than the arithmetic: choose a true distance,
  // publish the depth that encodes it, and require that distance back.
  const TRUE_DISTANCE = 8998.96;
  const depth = (TRUE_DISTANCE - ENCODE_NEAR) / (ENCODE_FAR - ENCODE_NEAR);
  // A slice band that brackets the hit, exactly as the real one does. It is
  // the plausible wrong answer, so the test is only passable one way.
  const slices = [{ near: 8986.75, far: 9110.8, depth: depth }];
  const target = Cartesian3.fromDegrees(-75.0, 40.0, 0.0);
  const { scene, picking } = rayHarness({ slices });
  const before = Cartesian3.clone(target);
  const ray = getRayForClampToHeight(scene, before);

  const result = await Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    [target],
  );

  assert.notEqual(result[0], undefined, "the hit must be recovered at all");
  const recovered = Cartesian3.distance(result[0], ray.origin);
  assert.ok(
    Math.abs(recovered - TRUE_DISTANCE) < 1.0e-3,
    `a hit at ${TRUE_DISTANCE} m must come back at ${TRUE_DISTANCE} m, not ` +
      `${recovered} m`,
  );
  const sliceFramed = slices[0].near + depth * (slices[0].far - slices[0].near);
  assert.ok(
    Math.abs(recovered - sliceFramed) > 1.0,
    "and it must not be the slice-band reconstruction, which lands " +
      `${Math.abs(sliceFramed - TRUE_DISTANCE).toFixed(2)} m away at ` +
      `${sliceFramed.toFixed(2)} m`,
  );
});

test("each point reads its OWN render's depth, not the last render's", async () => {
  // Pins `Picking._offscreenRayPickChain`. The offscreen view, its slices and
  // its depth target are shared state, and a batch of height queries resolves
  // its callbacks in a single microtask drain. Without serialization every
  // render runs before the first readback lands, the one depth target ends up
  // holding the LAST render's depth, and all N points decode that same value —
  // which measured as thirty nearly identical heights, 24 m from WebGL's, on
  // terrain whose real relief is 20 m.
  //
  // The observable, stated without reference to the chain: three points whose
  // renders produce three different depths must come back at three different
  // distances, each its own.
  const distances = [8800.0, 8900.0, 9000.0];
  const depths = distances.map(
    (d) => (d - ENCODE_NEAR) / (ENCODE_FAR - ENCODE_NEAR),
  );
  const targets = [
    Cartesian3.fromDegrees(-75.0, 40.0, 0.0),
    Cartesian3.fromDegrees(-75.001, 40.0, 0.0),
    Cartesian3.fromDegrees(-75.002, 40.0, 0.0),
  ];
  const before = targets.map((t) => Cartesian3.clone(t));
  const { scene, picking } = rayHarness({
    slices: ONE_HIT_SLICE,
    perRenderDepths: depths,
  });

  const result = await Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    targets,
  );

  const recovered = result.map((position, i) =>
    Cartesian3.distance(
      position,
      getRayForClampToHeight(scene, before[i]).origin,
    ),
  );
  for (let i = 0; i < distances.length; ++i) {
    assert.ok(
      Math.abs(recovered[i] - distances[i]) < 1.0e-3,
      `point ${i} must read render ${i}'s depth (${distances[i]} m), not ` +
        `${recovered[i]} m`,
    );
  }
  assert.equal(
    new Set(recovered.map((d) => d.toFixed(3))).size,
    3,
    "three different renders must not collapse onto one answer",
  );
});

test("a publication lost mid-batch yields holes, not a rejected batch", async () => {
  // Lifecycle: device loss / context destroy while readbacks are in flight.
  // `WebGPUPickFramebuffer._destroyTextures` destroys the ray-depth targets, so
  // a readback already queued against one resolves `undefined` through its own
  // catch rather than throwing. The batch around it must survive that: points
  // taken before the loss keep their positions, points after become holes, and
  // the caller gets a RESOLVED array — the documented contract — instead of a
  // rejection it never had to handle before.
  const targets = [
    Cartesian3.fromDegrees(-75.0, 40.0, 0.0),
    Cartesian3.fromDegrees(-75.001, 40.0, 0.0),
    Cartesian3.fromDegrees(-75.002, 40.0, 0.0),
  ];
  const { scene, picking } = rayHarness({
    slices: ONE_HIT_SLICE,
    publishUntil: 1,
  });

  const result = await Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    targets,
  );

  assert.equal(result.length, 3, "the batch must resolve, with every slot");
  assert.notEqual(
    result[0],
    undefined,
    "the point picked before the loss keeps its position",
  );
  assert.equal(result[1], undefined, "the points after it are holes");
  assert.equal(result[2], undefined);
});

test("the capability flag and the behaviour behind it agree", async () => {
  // A flag that says the producer exists while the query answers undefined is
  // the failure mode this pair exists to prevent: `*MostDetailedSupported`
  // reads the capability, so a false claim reaches users as a broken promise
  // rather than an unsupported feature.
  const context = contextOf(WebGPUContext);
  assert.equal(
    read(GraphicsContext.prototype, CAPABILITY, context),
    true,
    "the WebGPU context must claim the offscreen ray-depth producer",
  );

  const target = Cartesian3.fromDegrees(-75.0, 40.0, 0.0);
  const { scene, picking } = rayHarness({ slices: ONE_SLICE });
  const result = await Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    [target],
  );
  assert.notEqual(
    result[0],
    undefined,
    "and a query on that backend must actually produce a position",
  );
});

test("nothing published means an honest undefined, not a stale position", async () => {
  // The producer's pre-fix state, and the shape of the inertness mutant: the
  // render happens, no depth is published, every entry is a hole.
  const target = Cartesian3.fromDegrees(-75.0, 40.0, 0.0);
  const { scene, picking } = rayHarness({
    slices: ONE_SLICE,
    publish: false,
  });

  const result = await Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    [target],
  );

  assert.equal(
    result[0],
    undefined,
    "with no published depth the query must report failure, and this is the " +
      "exact observation the demo turned into a Cartesian3.pack error",
  );
});

test("a synchronous-readback backend keeps the synchronous recovery", async () => {
  const target = Cartesian3.fromDegrees(-75.0, 40.0, 0.0);
  const { scene, picking, log, requestedDuringRender } = rayHarness({
    slices: ONE_SLICE,
    synchronous: true,
  });
  const before = Cartesian3.clone(target);

  const result = await Picking.prototype.clampToHeightMostDetailed.call(
    picking,
    scene,
    [target],
  );

  const expected = expectedRayPosition(scene, before, 0, ONE_SLICE, true);
  assert.ok(
    Cartesian3.equalsEpsilon(result[0], expected, 1.0e-6),
    "the synchronous path must still clamp",
  );
  assert.ok(log.includes("getDepth"), "it must read the depth synchronously");
  assert.ok(
    !log.includes("readDepthAsync"),
    "it must NOT take the asynchronous chain — WebGL's path is unchanged",
  );
  assert.ok(
    requestedDuringRender.every((requested) => requested === false),
    "a backend that reads depth in the call must not ask for the extra " +
      "publication",
  );
});

test("sampled heights come back defined for a whole batch", async () => {
  const first = Cartographic.fromDegrees(-75.0, 40.0, 125.0);
  const second = Cartographic.fromDegrees(-75.001, 40.0, 125.0);
  const { scene, picking } = rayHarness({ slices: ONE_HIT_SLICE });
  const firstBefore = Cartographic.clone(first);

  const result = await Picking.prototype.sampleHeightMostDetailed.call(
    picking,
    scene,
    [first, second],
  );

  for (let i = 0; i < result.length; ++i) {
    assert.notEqual(
      result[i].height,
      undefined,
      `entry ${i} sampled undefined`,
    );
  }
  const expected = getHeightFromCartesian(
    scene,
    Ray.getPoint(
      // The ray is built from longitude and latitude only (the sampled height
      // is what it is looking for), so the post-call height does not change it.
      getRayForSampleHeight(scene, firstBefore),
      // The distance the published depth reports in the frame the render
      // encoded it in, which is the camera's.
      RAY_HIT_DISTANCE,
    ),
  );
  assert.ok(
    Math.abs(result[0].height - expected) < 1.0e-6,
    `the sampled height must come from the recovered distance (${result[0].height} vs ${expected})`,
  );
});

// ── the readback primitive itself, over a fake device ────────────────────────

/**
 * A GPUDevice stand-in. Each staging buffer remembers the texture origin that
 * was copied into it, so the depth it hands back is the depth of the pixel the
 * caller actually asked for — the property the queue exists to preserve.
 */
function fakeDevice(encoding = "rgba8unorm", latencyFor) {
  return {
    createBuffer() {
      const buffer = {
        origin: undefined,
        async mapAsync() {
          // Real `mapAsync` latency is not uniform. Where a test supplies
          // `latencyFor`, requests can complete out of the order they were
          // made — which is the only condition under which a serialized queue
          // and an unserialized one differ.
          const ticks = isDefined(latencyFor)
            ? latencyFor(buffer.origin?.x ?? 0)
            : READBACK_TICKS;
          for (let i = 0; i < ticks; ++i) {
            await macrotask();
          }
        },
        getMappedRange() {
          const depth = depthForColumn(buffer.origin?.x ?? 0);
          if (encoding === "r32float") {
            // What the offscreen ray pick publishes: the depth verbatim.
            return new Float32Array([depth]).buffer;
          }
          const bytes = new Uint8Array(4);
          bytes[0] = Math.round(depth * 255);
          return bytes.buffer;
        },
        unmap() {},
        destroy() {},
      };
      return buffer;
    },
    createCommandEncoder() {
      return {
        copyTextureToBuffer(source, destination) {
          destination.buffer.origin = source.origin;
        },
        finish() {
          return {};
        },
      };
    },
    queue: {
      submit() {},
    },
  };
}

test("concurrent depth readbacks each answer for their own coordinate", async () => {
  const pickDepth = new PickDepth();
  pickDepth._asyncDepthTexture = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  const context = { _device: fakeDevice() };

  const [first, second, third] = await Promise.all([
    pickDepth.readDepthAsync(context, 11, 100),
    pickDepth.readDepthAsync(context, 22, 100),
    pickDepth.readDepthAsync(context, 33, 100),
  ]);

  assert.equal(first, depthForColumn(11));
  assert.equal(second, depthForColumn(22));
  assert.equal(
    third,
    depthForColumn(33),
    "a queued readback must read its own pixel, not serve the value the " +
      "fire-and-forget path happened to leave in the cache",
  );
});

test("the cache ends up holding the pixel the last readback asked for", async () => {
  // Pins `PickDepth._readbackQueue`. `readDepthAsync` resolves each caller with
  // its own value either way — every readback owns its staging buffer — so what
  // serialization actually protects is the ONE cache slot
  // (`_lastDepthValue`/`_lastDepthX/Y`) that the synchronous `getDepth` serves
  // from. Queued, the requests settle in the order they were made and the slot
  // ends up keyed to the last of them. Unqueued, they race, and the slowest
  // request wins the slot no matter when it was asked for.
  //
  // The observable is `getDepth`'s documented contract: a synchronous query at
  // the pixel the last readback asked about is served from the cache rather
  // than reading cold. Latency descends with x, so an unserialized queue
  // finishes them in reverse.
  const pickDepth = new PickDepth();
  pickDepth._asyncDepthTexture = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  const context = {
    _device: fakeDevice("rgba8unorm", (x) => (x === 11 ? 9 : x === 22 ? 5 : 1)),
    supportsSynchronousReadback: false,
  };

  await Promise.all([
    pickDepth.readDepthAsync(context, 11, 100),
    pickDepth.readDepthAsync(context, 22, 100),
    pickDepth.readDepthAsync(context, 33, 100),
  ]);

  assert.equal(
    pickDepth.getDepth(context, 33, 100),
    depthForColumn(33),
    "the pixel asked for last must be the one a synchronous query can serve; " +
      "unserialized, the slowest request (x=11) overwrites the slot and this " +
      "reads undefined",
  );
});

test("a failed readback does not wedge the queue behind it", async () => {
  const pickDepth = new PickDepth();
  pickDepth._asyncDepthTexture = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  const device = fakeDevice();
  const healthy = device.createBuffer;
  let failNext = true;
  device.createBuffer = function () {
    if (failNext) {
      failNext = false;
      throw new Error("device lost mid-readback");
    }
    return healthy.call(device);
  };
  const context = { _device: device };

  const [failed, recovered] = await Promise.all([
    pickDepth.readDepthAsync(context, 44, 100),
    pickDepth.readDepthAsync(context, 55, 100),
  ]);

  assert.equal(failed, undefined, "the failed readback must report undefined");
  assert.equal(
    recovered,
    depthForColumn(55),
    "the next caller must still get its own depth",
  );
});

test("the published texture's format decides how the depth is decoded", async () => {
  // Two publication formats reach one readback. The offscreen ray pick gets
  // `r32float`, verbatim, because it reconstructs against the ray camera's
  // 0.1-to-5e8 frustum, where the RGBA8 pack's 24 bits are a 30 m quantum --
  // coarser than the terrain being sampled. Everything else still gets the
  // pack, because it reconstructs against a narrow slice where 24 bits are
  // micrometres.
  //
  // Both decodings return a plausible number for either texture, so a swap is
  // silent. That is what this test is for: the same published depth, read
  // through both formats, must come back as itself.
  const asFloat = new PickDepth();
  asFloat._asyncDepthTexture = {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    format: "r32float",
  };
  assert.equal(
    await asFloat.readDepthAsync({ _device: fakeDevice("r32float") }, 11, 100),
    Math.fround(depthForColumn(11)),
    "an r32float publication must read back as the float that was written",
  );

  const asPacked = new PickDepth();
  asPacked._asyncDepthTexture = {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    format: "rgba8unorm",
  };
  assert.equal(
    await asPacked.readDepthAsync({ _device: fakeDevice() }, 11, 100),
    depthForColumn(11),
    "and a packed publication must still be unpacked",
  );
});

test("a depth too fine for the RGBA8 pack survives the float publication", async () => {
  // The measured value from the failing run: the depth of a real 3D-tile hit
  // ~8999 m down the ray, encoded against the ray camera's whole frustum. The
  // RGBA8 pack truncates it to one of two values 30 m apart -- which is how 30
  // sampled points, spread over 20 m of relief, produced two distinct answers.
  const MEASURED = 1.799978781491518e-5;
  const pickDepth = new PickDepth();
  pickDepth._asyncDepthTexture = { width: 1, height: 1, format: "r32float" };
  const device = fakeDevice("r32float");
  const createBuffer = device.createBuffer;
  device.createBuffer = function () {
    const buffer = createBuffer.call(device);
    buffer.getMappedRange = () => new Float32Array([MEASURED]).buffer;
    return buffer;
  };

  const read = await pickDepth.readDepthAsync({ _device: device }, 0, 0);
  assert.equal(read, Math.fround(MEASURED));
  // The distance that depth reports, and the distance the pack would have
  // reported for it, across Picking's offscreen frustum.
  const exact = ENCODE_NEAR + read * (ENCODE_FAR - ENCODE_NEAR);
  const packed =
    ENCODE_NEAR +
    (Math.floor(MEASURED * 16581375.0) / 16581375.0) *
      (ENCODE_FAR - ENCODE_NEAR);
  assert.ok(
    Math.abs(exact - packed) > 1.0,
    "the pack must be shown to lose more than a metre here, or this test is " +
      `asserting nothing (it lost ${Math.abs(exact - packed).toFixed(2)} m)`,
  );
});

test("a readback with no published texture answers undefined", async () => {
  // Device loss destroys the pick framebuffer's targets; a query that arrives
  // after that must report no depth rather than throw into the caller's batch.
  const pickDepth = new PickDepth();
  const context = { _device: fakeDevice() };
  assert.equal(await pickDepth.readDepthAsync(context, 0, 0), undefined);

  pickDepth._asyncDepthTexture = { width: 1, height: 1 };
  assert.equal(
    await pickDepth.readDepthAsync({ _device: null }, 0, 0),
    undefined,
    "a context whose device is gone must answer undefined too",
  );
});
