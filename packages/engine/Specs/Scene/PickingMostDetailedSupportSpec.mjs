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

test("WebGPU reports the offscreen ray-depth capability as unsupported", () => {
  assert.notEqual(
    Object.getOwnPropertyDescriptor(WebGPUContext.prototype, CAPABILITY),
    undefined,
    "WebGPUContext must own an override for the capability",
  );
  assert.equal(
    read(WebGPUContext.prototype, CAPABILITY, contextOf(WebGPUContext)),
    false,
    "a WebGPU context must report the offscreen ray-depth path as missing",
  );
});

test("Scene gates only the *MostDetailed variants on the capability", () => {
  const webgl = sceneOn(contextOf(Context));
  const webgpu = sceneOn(contextOf(WebGPUContext));

  for (const [label, scene, expected] of [
    ["WebGL", webgl, true],
    ["WebGPU", webgpu, false],
  ]) {
    assert.equal(
      scene.sampleHeightMostDetailedSupported,
      expected,
      `sampleHeightMostDetailedSupported must be ${expected} on ${label}`,
    );
    assert.equal(
      scene.clampToHeightMostDetailedSupported,
      expected,
      `clampToHeightMostDetailedSupported must be ${expected} on ${label}`,
    );
  }

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
  // context, so a getter that ignored one of its two terms fails here.
  for (const depthTexture of [true, false]) {
    for (const capability of [true, false]) {
      const scene = sceneOn({
        depthTexture: depthTexture,
        [CAPABILITY]: capability,
      });
      const expected = depthTexture && capability;
      assert.equal(
        scene.sampleHeightMostDetailedSupported,
        expected,
        `depthTexture=${depthTexture} capability=${capability}`,
      );
      assert.equal(
        scene.clampToHeightMostDetailedSupported,
        expected,
        `depthTexture=${depthTexture} capability=${capability}`,
      );
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
